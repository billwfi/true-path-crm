const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');
const RTS = require('./_rts');

// TRK1 — package delivery support / RTS prevention.
//   GET  /rts?order_id=            -> the case for an order (+ today's requirement, scripts)
//   GET  /rts?case_id=             -> one case by id
//   GET  /rts?resource=queue[&mine=1&state=] -> open cases needing attention
//   POST /rts?order_id=            -> open a case
//   POST /rts?case_id=&resource=contact       -> log today's contact attempt
//   POST /rts?case_id=&resource=plan          -> record an actionable plan / scheduled redelivery
//   POST /rts?case_id=&resource=courtesy-hold -> record the local-office courtesy hold request
//   PATCH /rts?case_id=            -> update classification / service requests / docs / close

const STATUSES = ['Open', 'Resolved', 'Returned to Sender', 'Closed'];

async function loadCase(where, params) {
  return (await mssql(`SELECT * FROM dbo.tp_rts_cases WHERE ${where}`, params)).recordset[0];
}
async function contactsFor(caseId) {
  return (await mssql(
    `SELECT * FROM dbo.tp_rts_contacts WHERE case_id=@id ORDER BY contact_date DESC, id DESC`,
    { id: caseId })).recordset;
}
// Everything the UI needs to render a case: the SOP verdict for today + filled scripts.
async function caseBundle(c) {
  const contacts = await contactsFor(c.id);
  const requirement = RTS.requirementFor(c, contacts);
  const courtesy = RTS.courtesyHold(c);
  const deadline = RTS.holdDeadline(c);
  const docs = RTS.docStatus(c);
  const scripts = (await mssql(
    `SELECT script_key, title, script_text FROM dbo.tp_getrx_scripts WHERE trigger_point='rts' AND active=1 ORDER BY sort_order`))
    .recordset.map(s => ({
      ...s,
      script_text: (s.script_text || '')
        .replace(/\{\{\s*hold_date\s*\}\}/gi, deadline || '[hold date]')
        .replace(/\{\{\s*extension\s*\}\}/gi, courtesy.text || '[extension]'),
    }));
  return { case: c, contacts, requirement, courtesy, deadline, docs, scripts,
           package_types: RTS.PACKAGE_TYPES, issue_categories: RTS.ISSUE_CATEGORIES };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();
  const q = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (q.resource === 'queue') return queue(q, user);
      let c = null;
      if (q.case_id) c = await loadCase('id=@id', { id: parseInt(q.case_id, 10) });
      else if (q.order_id) c = await loadCase('order_id=@id AND status<>\'Closed\'', { id: parseInt(q.order_id, 10) });
      else return badRequest('order_id or case_id required');
      if (!c) return ok({ case: null });
      return ok(await caseBundle(c));
    }

    if (event.httpMethod === 'POST') {
      if (q.resource === 'contact') return logContact(q, event, user);
      if (q.resource === 'plan') return setPlan(q, event, user);
      if (q.resource === 'courtesy-hold') return courtesyHold(q, event, user);

      // Open a case against a shipped order.
      const orderId = parseInt(q.order_id, 10);
      if (!orderId) return badRequest('order_id required');
      const o = (await mssql('SELECT * FROM dbo.tp_orders WHERE id=@id', { id: orderId })).recordset[0];
      if (!o) return notFound();
      const existing = await loadCase('order_id=@id AND status<>\'Closed\'', { id: orderId });
      if (existing) return badRequest('An open delivery-support case already exists for this order');

      const b = JSON.parse(event.body || '{}');
      const category = RTS.ISSUE_CATEGORIES.includes(b.issue_category) ? b.issue_category : 'RTS Escalation';
      const rule = RTS.packageRule(b.package_type);
      // Invalid Address = immediate RTS, no hold period.
      const start = category === 'Invalid Address' ? null : (b.hold_start_date || o.shipped_date || new Date().toISOString().slice(0, 10));
      const r = await mssql(
        `INSERT INTO dbo.tp_rts_cases
           (order_id, member_key, intake_type, issue_category, package_type, medication_type,
            signature_required, hold_start_date, hold_days, opened_by, updated_at)
         OUTPUT INSERTED.id
         VALUES (@oid, @m, @c, @cat, @pt, @mt, @sig, @start, @days, @by, SYSUTCDATETIME())`,
        { oid: orderId, m: o.member_key, c: o.intake_type, cat: category,
          pt: b.package_type || null, mt: b.medication_type || null,
          sig: rule && rule.signature_required ? 1 : 0,
          start: start ? String(start).slice(0, 10) : null,
          days: rule ? rule.hold_days : null, by: user.id || null });
      // Flag the order so it shows in the tracking queue as a problem shipment.
      await mssql(
        `UPDATE dbo.tp_orders SET delay_flag=1, delay_notes=@n, updated_at=SYSUTCDATETIME() WHERE id=@id`,
        { n: `Delivery support: ${category}`, id: orderId });
      await mssql(
        `INSERT INTO dbo.tp_tracking_events (order_id, event_type, status, notes, created_by)
         VALUES (@id, 'RTS', @s, @n, @by)`,
        { id: orderId, s: category, n: `Delivery-support case opened${b.package_type ? ` — ${b.package_type}` : ''}`, by: user.id || null });
      const c = await loadCase('id=@id', { id: r.recordset[0].id });
      return created(await caseBundle(c));
    }

    if (event.httpMethod === 'PATCH') {
      const id = parseInt(q.case_id, 10);
      if (!id) return badRequest('case_id required');
      const cur = await loadCase('id=@id', { id });
      if (!cur) return notFound();
      const b = JSON.parse(event.body || '{}');
      const sets = [], p = { id };

      if ('issue_category' in b && RTS.ISSUE_CATEGORIES.includes(b.issue_category)) {
        sets.push('issue_category=@cat'); p.cat = b.issue_category;
      }
      if ('package_type' in b) {
        const rule = RTS.packageRule(b.package_type);
        sets.push('package_type=@pt', 'hold_days=@days', 'signature_required=@sig');
        p.pt = b.package_type || null;
        p.days = rule ? rule.hold_days : null;
        p.sig = rule && rule.signature_required ? 1 : 0;
      }
      if ('medication_type' in b) { sets.push('medication_type=@mt'); p.mt = b.medication_type || null; }
      if ('hold_start_date' in b) { sets.push('hold_start_date=@hs'); p.hs = b.hold_start_date || null; }
      if ('service_requests' in b) { sets.push('service_requests=@sr'); p.sr = (b.service_requests || '').slice(0, 500) || null; }
      if ('doc_checklist' in b) { sets.push('doc_checklist=@doc'); p.doc = JSON.stringify(b.doc_checklist || {}); }
      if ('resolution' in b) { sets.push('resolution=@res'); p.res = (b.resolution || '').slice(0, 200) || null; }

      if ('status' in b) {
        const st = STATUSES.includes(b.status) ? b.status : 'Open';
        // SOP §12 — a case cannot be closed until its documentation is complete.
        if (st !== 'Open') {
          const merged = { ...cur, doc_checklist: 'doc_checklist' in b ? JSON.stringify(b.doc_checklist || {}) : cur.doc_checklist };
          const docs = RTS.docStatus(merged);
          if (!docs.complete) {
            return badRequest('Documentation incomplete — required before closing: ' + docs.missing.join('; '));
          }
          sets.push('closed_by=@cby', 'closed_at=SYSUTCDATETIME()');
          p.cby = user.id || null;
        }
        sets.push('status=@st'); p.st = st;
      }
      if (!sets.length) return badRequest('no updatable fields');
      sets.push('updated_at=SYSUTCDATETIME()');
      await mssql(`UPDATE dbo.tp_rts_cases SET ${sets.join(', ')} WHERE id=@id`, p);

      const after = await loadCase('id=@id', { id });
      // Closing the case clears the order's delay flag.
      if (after.status && after.status !== 'Open') {
        await mssql(`UPDATE dbo.tp_orders SET delay_flag=0, updated_at=SYSUTCDATETIME() WHERE id=@oid`, { oid: after.order_id });
        await mssql(
          `INSERT INTO dbo.tp_tracking_events (order_id, event_type, status, notes, created_by)
           VALUES (@id, 'RTS', @s, @n, @by)`,
          { id: after.order_id, s: after.status, n: after.resolution || null, by: user.id || null });
      }
      return ok(await caseBundle(after));
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};

// Log a day's contact attempt against the SOP requirement.
async function logContact(q, event, user) {
  const id = parseInt(q.case_id, 10);
  if (!id) return badRequest('case_id required');
  const c = await loadCase('id=@id', { id });
  if (!c) return notFound();
  const b = JSON.parse(event.body || '{}');
  const date = b.contact_date || new Date().toISOString().slice(0, 10);
  const day = RTS.dayNumber(c, date);

  // One row per day — a second log for the same day updates it, so the
  // required channels can be ticked off as the rep works through them.
  const existing = (await mssql(
    `SELECT TOP 1 id, did_text, did_call, did_email FROM dbo.tp_rts_contacts
     WHERE case_id=@id AND contact_date=@d`, { id, d: date })).recordset[0];
  const params = {
    id, d: date, day,
    text: (b.did_text || (existing && existing.did_text)) ? 1 : 0,
    call: (b.did_call || (existing && existing.did_call)) ? 1 : 0,
    email: (b.did_email || (existing && existing.did_email)) ? 1 : 0,
    reached: b.reached ? 1 : 0,
    plan: (b.member_plan || '').slice(0, 500) || null,
    carrier: (b.carrier_note || '').slice(0, 500) || null,
    tracking: (b.tracking_status || '').slice(0, 200) || null,
    notes: b.notes || null, by: user.id || null,
  };
  if (existing) {
    await mssql(
      `UPDATE dbo.tp_rts_contacts SET did_text=@text, did_call=@call, did_email=@email, reached=@reached,
         member_plan=COALESCE(@plan, member_plan), carrier_note=COALESCE(@carrier, carrier_note),
         tracking_status=COALESCE(@tracking, tracking_status),
         notes=COALESCE(@notes, notes), day_no=@day
       WHERE id=@rid`, { ...params, rid: existing.id });
  } else {
    await mssql(
      `INSERT INTO dbo.tp_rts_contacts
         (case_id, contact_date, day_no, did_text, did_call, did_email, reached, member_plan, carrier_note, tracking_status, notes, created_by)
       VALUES (@id, @d, @day, @text, @call, @email, @reached, @plan, @carrier, @tracking, @notes, @by)`, params);
  }
  const after = await loadCase('id=@id', { id });
  return created(await caseBundle(after));
}

// An actionable pickup plan or a scheduled redelivery suppresses daily contact.
async function setPlan(q, event, user) {
  const id = parseInt(q.case_id, 10);
  if (!id) return badRequest('case_id required');
  const b = JSON.parse(event.body || '{}');
  if (b.clear) {
    await mssql(
      `UPDATE dbo.tp_rts_cases SET plan_active=0, plan_date=NULL, plan_notes=NULL, plan_source=NULL,
         updated_at=SYSUTCDATETIME() WHERE id=@id`, { id });
  } else {
    if (!b.plan_date) return badRequest('plan_date is required — a plan must be specific and actionable');
    await mssql(
      `UPDATE dbo.tp_rts_cases SET plan_active=1, plan_date=@d, plan_notes=@n, plan_source=@s,
         updated_at=SYSUTCDATETIME() WHERE id=@id`,
      { id, d: b.plan_date, n: (b.plan_notes || '').slice(0, 500) || null,
        s: b.plan_source === 'Scheduled Redelivery' ? 'Scheduled Redelivery' : 'Member Plan' });
  }
  const after = await loadCase('id=@id', { id });
  return ok(await caseBundle(after));
}

// Courtesy hold is granted only by the LOCAL office (SOP) — we record the outcome.
async function courtesyHold(q, event, user) {
  const id = parseInt(q.case_id, 10);
  if (!id) return badRequest('case_id required');
  const c = await loadCase('id=@id', { id });
  if (!c) return notFound();
  const b = JSON.parse(event.body || '{}');
  const ext = RTS.COURTESY_EXTENSION[c.medication_type];
  if (!ext) return badRequest('Set the medication type (Refrigerated or Ambient) first — it determines the extension');
  const granted = b.granted === false ? 0 : 1;
  await mssql(
    `UPDATE dbo.tp_rts_cases SET courtesy_hold_requested=1, courtesy_hold_at=SYSUTCDATETIME(),
       hold_extension_days=@ext, updated_at=SYSUTCDATETIME() WHERE id=@id`,
    { id, ext: granted ? ext : 0 });
  // Fold the note into today's log row if one exists, so a day never gets two entries.
  const note = `Courtesy hold ${granted ? 'granted' : 'refused'} by local office${b.clerk ? ` (${b.clerk})` : ''}`;
  const today = new Date().toISOString().slice(0, 10);
  const existing = (await mssql(
    `SELECT TOP 1 id, carrier_note FROM dbo.tp_rts_contacts WHERE case_id=@id AND contact_date=@d`,
    { id, d: today })).recordset[0];
  if (existing) {
    await mssql(
      `UPDATE dbo.tp_rts_contacts
       SET carrier_note = LEFT(LTRIM(RTRIM(ISNULL(carrier_note + ' · ', '') + @cn)), 500),
           notes = COALESCE(@n, notes)
       WHERE id=@rid`, { rid: existing.id, cn: note, n: b.notes || null });
  } else {
    await mssql(
      `INSERT INTO dbo.tp_rts_contacts (case_id, contact_date, day_no, carrier_note, notes, created_by)
       VALUES (@id, @d, @day, @cn, @n, @by)`,
      { id, d: today, day: RTS.dayNumber(c), cn: note, n: b.notes || null, by: user.id || null });
  }
  const after = await loadCase('id=@id', { id });
  return ok(await caseBundle(after));
}

// Open cases, ordered by urgency — what needs contacting today.
async function queue(q, user) {
  const conds = [`c.status='Open'`];
  const p = { uid: user.id };
  if (q.mine === '1') { conds.push('o.assigned_to=@uid'); }
  if (q.category) { conds.push('c.issue_category=@cat'); p.cat = q.category; }
  const rows = (await mssql(`
    SELECT c.*, o.medication, o.strength, o.carrier, o.tracking_number, o.assigned_to,
           LTRIM(RTRIM(CONCAT(u.firstname,' ',u.lastname))) AS assigned_name,
           a.First_Name, a.Last_Name, a.Group_Name, a.indx AS ready_indx
    FROM dbo.tp_rts_cases c
    JOIN dbo.tp_orders o ON o.id=c.order_id
    LEFT JOIN dbo.Users u ON u.id=o.assigned_to
    OUTER APPLY (SELECT TOP 1 r.First_Name, r.Last_Name, r.Group_Name, r.indx FROM dbo.ReadyToAssign r
      WHERE r.category=c.intake_type
        AND COALESCE(NULLIF(r.Member_ID,''), CAST(r.indx AS VARCHAR(50)))=c.member_key
      ORDER BY r.indx DESC) a
    WHERE ${conds.join(' AND ')}
    ORDER BY c.hold_start_date, c.id`, p)).recordset;

  // Decorate each case with today's SOP verdict so the queue can be sorted by urgency.
  const out = [];
  for (const c of rows) {
    const contacts = await contactsFor(c.id);
    const req = RTS.requirementFor(c, contacts);
    const ch = RTS.courtesyHold(c);
    out.push({ ...c, requirement: req, courtesy: ch, deadline: RTS.holdDeadline(c) });
  }
  const summary = {
    open: out.length,
    contact_due: out.filter(x => !x.requirement.satisfied && ['week1', 'week2', 'plan-day'].includes(x.requirement.level)).length,
    week2: out.filter(x => x.requirement.level === 'week2').length,
    courtesy_due: out.filter(x => x.courtesy.due || x.courtesy.overdue).length,
  };
  return ok({ rows: out, summary });
}
