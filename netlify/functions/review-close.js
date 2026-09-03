const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');
const RB = require('./_rebates');

// CC Phase 5 — Review & Close workspace + rebates (RC1, RC2, CC3, RCS1).
//   GET  /review-close?resource=queue[&state=&search=]  -> R&C worklist + tiles
//   GET  /review-close?resource=recycling[&search=]     -> CC3 recycling queue
//   GET  /review-close?member=&category=                -> one case (+ rebates, options)
//   POST /review-close?member=&category=&resource=route -> route a member into R&C
//   PATCH /review-close?member=&category=               -> reviewer updates (verify, status, defer)
//   POST /review-close?member=&category=&resource=close -> close, with WHY + WHO enforced
//   POST /review-close?member=&category=&resource=rebate      -> raise an Issue Rebate task
//   PATCH /review-close?rebate_id=                      -> update / complete a rebate
//   GET  /review-close?resource=rebates[&status=]       -> rebate worklist + Friday export

const MEMBER_MATCH = `category=@c AND COALESCE(NULLIF(Member_ID,''), CAST(indx AS VARCHAR(50)))=@m`;

async function drugRules() {
  return (await mssql('SELECT * FROM dbo.tp_rebate_drug_rules WHERE active=1')).recordset;
}
async function memberInfo(member, cat) {
  const r = (await mssql(
    `SELECT TOP 1 First_Name, Last_Name, Group_Name, Group_Code, indx FROM dbo.ReadyToAssign
     WHERE ${MEMBER_MATCH} ORDER BY indx DESC`, { c: cat, m: member })).recordset[0] || {};
  return {
    first: (r.First_Name || '').trim(),
    full: `${(r.Last_Name || '').trim()}, ${(r.First_Name || '').trim()}`.replace(/^, |, $/, '') || member,
    group: r.Group_Name || null, group_code: r.Group_Code || null, indx: r.indx || null,
  };
}
function safeParse(j) { try { return j ? JSON.parse(j) : {}; } catch { return {}; } }

// Everything the reviewer needs for one case.
async function caseBundle(member, cat) {
  const c = (await mssql(
    `SELECT * FROM dbo.tp_review_close WHERE member_key=@m AND intake_type=@c`,
    { m: member, c: cat })).recordset[0] || null;
  const intake = (await mssql(
    `SELECT status, sub_status, priority, outreach_status, ticket_status, recycle_after
     FROM dbo.tp_member_intakes WHERE member_key=@m AND intake_type=@c`, { m: member, c: cat })).recordset[0] || null;
  const rebates = (await mssql(
    `SELECT * FROM dbo.tp_rebates WHERE member_key=@m AND intake_type=@c ORDER BY created_at DESC, id DESC`,
    { m: member, c: cat })).recordset;
  const orders = (await mssql(
    `SELECT id, medication, strength, day_supply, stage, delivered_date, delivery_confirmed,
            tracking_number, carrier, batch_id, delay_flag
     FROM dbo.tp_orders WHERE member_key=@m AND intake_type=@c ORDER BY created_at DESC`,
    { m: member, c: cat })).recordset;
  const attempts = (await mssql(
    `SELECT COUNT(*) n FROM dbo.GLP1_ContactLog WHERE member_key=@m AND category=@c`,
    { m: member, c: cat })).recordset[0].n;
  const nm = await memberInfo(member, cat);

  const issued = rebates.filter(r => r.status === 'Completed').length;
  const due = RB.rebateDue(issued);
  // RC1: delivery must be present and consistent before closing.
  const delivered = orders.filter(o => o.delivered_date);
  const verification = {
    has_order: orders.length > 0,
    delivery_date_present: delivered.length > 0,
    delivery_confirmed: delivered.some(o => o.delivery_confirmed),
    transaction_present: rebates.some(r => r.transaction_number) || delivered.length > 0,
    rts_or_delay: orders.some(o => o.delay_flag),
  };
  return {
    case: c, intake, rebates, orders, attempts, member_name: nm.full, group: nm.group, ready_indx: nm.indx,
    rebate_due: due, verification,
    invalid_info_eligible: RB.invalidInfoEligible(attempts),
    options: {
      close_reasons: RB.CLOSE_REASONS, reasons_needing_auth: RB.REASONS_NEEDING_AUTH,
      member_statuses: RB.MEMBER_STATUSES, ticket_statuses: RB.TICKET_STATUSES,
      rebate_statuses: RB.REBATE_STATUSES, close_checklist: RB.CLOSE_CHECKLIST,
      rebate_checklist: RB.REBATE_CHECKLIST, placeholder_dates: RB.PLACEHOLDER_DATES,
      max_rebates: RB.MAX_REBATES,
    },
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();
  const q = event.queryStringParameters || {};
  const cat = q.category || 'GLP1';

  try {
    if (event.httpMethod === 'GET') {
      if (q.resource === 'queue') return queue(q, user);
      if (q.resource === 'recycling') return recycling(q);
      if (q.resource === 'rebates') return rebateList(q);
      if (!q.member) return badRequest('member or resource required');
      return ok(await caseBundle(q.member, cat));
    }

    if (event.httpMethod === 'POST') {
      if (!q.member) return badRequest('member is required');
      const b = JSON.parse(event.body || '{}');

      if (q.resource === 'route') {
        // Manually route a member into Review & Close.
        await mssql(
          `MERGE dbo.tp_review_close AS t
           USING (SELECT @m AS member_key, @c AS intake_type) AS s
           ON t.member_key=s.member_key AND t.intake_type=s.intake_type
           WHEN MATCHED THEN UPDATE SET status='Open', reason=@r, routed_by=@by, routed_at=SYSUTCDATETIME(),
             resolved_by=NULL, resolved_at=NULL
           WHEN NOT MATCHED THEN INSERT (member_key, intake_type, reason, status, routed_by)
             VALUES (@m, @c, @r, 'Open', @by);`,
          { m: q.member, c: cat, r: (b.reason || 'Manually routed').slice(0, 200), by: user.id || null });
        return ok(await caseBundle(q.member, cat));
      }

      if (q.resource === 'rebate') return createRebate(q, b, user);

      if (q.resource === 'close') {
        const cur = (await mssql(
          `SELECT * FROM dbo.tp_review_close WHERE member_key=@m AND intake_type=@c`,
          { m: q.member, c: cat })).recordset[0];
        if (!cur) return notFound();
        const checklist = b.checklist || safeParse(cur.checklist);
        const v = RB.validateClose({
          close_reason: b.close_reason, close_detail: b.close_detail,
          authorized_by: b.authorized_by, member_status: b.member_status, checklist,
        });
        if (!v.ok) return badRequest(v.errors.join(' · '));

        await mssql(
          `UPDATE dbo.tp_review_close
           SET status=@st, close_reason=@cr, close_detail=@cd, authorized_by=@auth,
               member_status=@ms, checklist=@cl, reviewed_by=@by, reviewed_at=SYSUTCDATETIME(),
               resolved_by=@by, resolved_at=SYSUTCDATETIME()
           WHERE member_key=@m AND intake_type=@c`,
          { m: q.member, c: cat, st: b.recycle ? 'Recycled' : 'Closed',
            cr: b.close_reason, cd: (b.close_detail || '').slice(0, 500),
            auth: (b.authorized_by || '').slice(0, 120) || null, ms: b.member_status,
            cl: JSON.stringify(checklist), by: user.id || null });

        // Reflect the outcome on the intake: profile status, ticket status, recycle date.
        await mssql(
          `UPDATE dbo.tp_member_intakes
           SET outreach_status=@ms, outreach_status_at=SYSUTCDATETIME(),
               ticket_status='Closed', recycle_after=@ra, updated_by=@by, updated_at=GETDATE()
           WHERE member_key=@m AND intake_type=@c`,
          { m: q.member, c: cat, ms: b.member_status, by: user.id || null,
            ra: b.recycle_after || null });
        return ok(await caseBundle(q.member, cat));
      }
      return badRequest('unknown resource');
    }

    if (event.httpMethod === 'PATCH') {
      if (q.rebate_id) return updateRebate(q, event, user);
      if (!q.member) return badRequest('member is required');
      const b = JSON.parse(event.body || '{}');

      // Reviewer's working updates on the case.
      const sets = [], p = { m: q.member, c: cat };
      if ('delivery_verified' in b)   { sets.push('delivery_verified=@dv'); p.dv = b.delivery_verified ? 1 : 0; }
      if ('transaction_present' in b) { sets.push('transaction_present=@tp'); p.tp = b.transaction_present ? 1 : 0; }
      if ('rts_flagged' in b)         { sets.push('rts_flagged=@rts'); p.rts = b.rts_flagged ? 1 : 0; }
      if ('checklist' in b)           { sets.push('checklist=@cl'); p.cl = JSON.stringify(b.checklist || {}); }
      if ('deferred_until' in b)      { sets.push('deferred_until=@du'); p.du = b.deferred_until || null; }
      if ('reason' in b)              { sets.push('reason=@rsn'); p.rsn = (b.reason || '').slice(0, 200) || null; }
      if (sets.length) {
        sets.push('reviewed_by=@by', 'reviewed_at=SYSUTCDATETIME()'); p.by = user.id || null;
        await mssql(`UPDATE dbo.tp_review_close SET ${sets.join(', ')} WHERE member_key=@m AND intake_type=@c`, p);
      }
      // Intake-level fields the reviewer can set without closing.
      const isets = [], ip = { m: q.member, c: cat, by: user.id || null };
      if ('outreach_status' in b && RB.MEMBER_STATUSES.includes(b.outreach_status)) {
        isets.push('outreach_status=@os', 'outreach_status_at=SYSUTCDATETIME()'); ip.os = b.outreach_status;
      }
      if ('ticket_status' in b && RB.TICKET_STATUSES.includes(b.ticket_status)) {
        isets.push('ticket_status=@ts'); ip.ts = b.ticket_status;
      }
      if ('recycle_after' in b) { isets.push('recycle_after=@ra'); ip.ra = b.recycle_after || null; }
      if (isets.length) {
        isets.push('updated_by=@by', 'updated_at=GETDATE()');
        await mssql(`UPDATE dbo.tp_member_intakes SET ${isets.join(', ')} WHERE member_key=@m AND intake_type=@c`, ip);
      }
      if (!sets.length && !isets.length) return badRequest('no updatable fields');
      return ok(await caseBundle(q.member, cat));
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};

// RC1 + RCS1 — raise the Issue Rebate task, after the transaction-date gate.
async function createRebate(q, b, user) {
  const cat = q.category || 'GLP1';
  const gate = RB.transactionDateGate({
    transaction_date: b.transaction_date, shipment_state: b.shipment_state,
    aub_number: b.aub_number, aub_required: !!b.aub_required,
  });
  if (!gate.ok) return badRequest(gate.errors.join(' · '));

  const rules = await drugRules();
  const calc = RB.calcRebate({ drug: b.medication, day_supply: b.day_supply, is_mrc: !!b.is_mrc, rules });
  if (calc.ineligible) return badRequest(calc.reason);
  if (calc.errors.length) return badRequest(calc.errors.join(' · '));

  const nm = await memberInfo(q.member, cat);
  const amount = b.amount_to_issue != null && b.amount_to_issue !== '' ? Number(b.amount_to_issue) : calc.amount;
  const monthly = b.monthly_amount != null && b.monthly_amount !== '' ? Number(b.monthly_amount) : calc.monthly;
  const status = RB.REBATE_STATUSES.includes(b.rebate_status) ? b.rebate_status : 'UNPAID';

  const r = await mssql(
    `INSERT INTO dbo.tp_rebates
       (member_key, intake_type, order_id, medication, strength, day_supply, rebate_status,
        monthly_amount, amount_to_issue, rule_applied, transaction_number, order_number,
        tracking_numbers, transaction_date, aub_number, rebate_address, proof_of_delivery,
        checklist, status, created_by, updated_at)
     OUTPUT INSERTED.id
     VALUES (@m, @c, @oid, @med, @str, @ds, @rs, @mo, @amt, @rule, @txn, @ord, @trk, @tdate, @aub,
             @addr, @pod, @cl, 'Open', @by, SYSUTCDATETIME())`,
    { m: q.member, c: cat, oid: b.order_id ? parseInt(b.order_id, 10) : null,
      med: (b.medication || '').slice(0, 200) || null, str: (b.strength || '').slice(0, 100) || null,
      ds: b.day_supply ? parseInt(b.day_supply, 10) : null, rs: status,
      mo: monthly, amt: amount, rule: (calc.rule || '').slice(0, 120) || null,
      txn: (b.transaction_number || '').slice(0, 80) || null, ord: (b.order_number || '').slice(0, 80) || null,
      trk: (b.tracking_numbers || '').slice(0, 500) || null, tdate: b.transaction_date || null,
      aub: (b.aub_number || '').slice(0, 60) || null, addr: (b.rebate_address || '').slice(0, 300) || null,
      pod: (b.proof_of_delivery || '').slice(0, 500) || null, cl: JSON.stringify(b.checklist || {}),
      by: user.id || null });
  const rebateId = r.recordset[0].id;

  // The SOP's Issue Rebate task: title, 14-15 days out, urgent, rebate group.
  const med = [b.medication, b.strength].filter(Boolean).join(' ') || 'Medication';
  const due = new Date(); due.setDate(due.getDate() + 15);
  const title = `Issue Rebate - ${med}${b.transaction_number ? ` - ${b.transaction_number}` : ''}`;
  const desc = [
    `Member: ${nm.full}`,
    `Monthly Rebate Amount: ${monthly != null ? '$' + monthly : '(enter)'}`,
    `Rebate to be Issued: ${amount != null ? '$' + amount : '(enter)'}`,
    `Transaction #: ${b.transaction_number || '(enter)'}`,
    `Order #: ${b.order_number || '(enter)'}`,
    `Tracking (US & international): ${b.tracking_numbers || '(enter)'}`,
    `Rebate Address: ${b.rebate_address || '(enter)'}`,
    `Proof of Delivery: ${b.proof_of_delivery || '(attach)'}`,
    calc.rule ? `Rule applied: ${calc.rule}` : null,
  ].filter(Boolean).join('\n');
  const t = await mssql(
    `INSERT INTO dbo.tp_tasks (name, status, priority, start_date, due_date, related_type, related_id, description, tags)
     OUTPUT INSERTED.id
     VALUES (@n, 'Open', 'Urgent', CAST(GETDATE() AS date), @due, 'CC Rebate', @rid, @d, 'Rebate')`,
    { n: title.slice(0, 1000), due: due.toISOString().slice(0, 10), rid: rebateId, d: desc });
  await mssql('UPDATE dbo.tp_rebates SET task_id=@t WHERE id=@id', { t: t.recordset[0].id, id: rebateId });

  // MAXED OUT tags the member profile per SOP.
  if (status === 'MAXED OUT') {
    await mssql(
      `UPDATE dbo.tp_member_intakes SET sub_status='Rebates MAXED OUT', updated_at=GETDATE()
       WHERE member_key=@m AND intake_type=@c`, { m: q.member, c: cat });
  }
  return created({ rebate_id: rebateId, task_id: t.recordset[0].id, amount, monthly,
                   rule: calc.rule, note: calc.reason });
}

async function updateRebate(q, event, user) {
  const id = parseInt(q.rebate_id, 10);
  const cur = (await mssql('SELECT * FROM dbo.tp_rebates WHERE id=@id', { id })).recordset[0];
  if (!cur) return notFound();
  const b = JSON.parse(event.body || '{}');
  const sets = [], p = { id };
  const map = { transaction_number: 80, order_number: 80, tracking_numbers: 500, rebate_address: 300, proof_of_delivery: 500, aub_number: 60 };
  for (const [k, len] of Object.entries(map)) if (k in b) { sets.push(`${k}=@${k}`); p[k] = (b[k] || '').slice(0, len) || null; }
  if ('rebate_status' in b && RB.REBATE_STATUSES.includes(b.rebate_status)) { sets.push('rebate_status=@rs'); p.rs = b.rebate_status; }
  if ('monthly_amount' in b)  { sets.push('monthly_amount=@mo'); p.mo = b.monthly_amount === '' ? null : Number(b.monthly_amount); }
  if ('amount_to_issue' in b) { sets.push('amount_to_issue=@amt'); p.amt = b.amount_to_issue === '' ? null : Number(b.amount_to_issue); }
  if ('transaction_date' in b) { sets.push('transaction_date=@td'); p.td = b.transaction_date || null; }
  if ('checklist' in b) { sets.push('checklist=@cl'); p.cl = JSON.stringify(b.checklist || {}); }

  if (b.complete) {
    // SOP: every checklist bubble must be checked before the task closes.
    const cl = b.checklist || safeParse(cur.checklist);
    const missing = RB.REBATE_CHECKLIST.filter(i => !cl[i.key]).map(i => i.label);
    if (missing.length) return badRequest('Rebate checklist incomplete: ' + missing.join('; '));
    sets.push(`status='Completed'`, 'completed_by=@cby', 'completed_at=SYSUTCDATETIME()');
    p.cby = user.id || null;
  }
  if (!sets.length) return badRequest('no updatable fields');
  sets.push('updated_at=SYSUTCDATETIME()');
  await mssql(`UPDATE dbo.tp_rebates SET ${sets.join(', ')} WHERE id=@id`, p);
  if (b.complete && cur.task_id) {
    await mssql(`UPDATE dbo.tp_tasks SET status='Completed' WHERE id=@t`, { t: cur.task_id });
  }
  const after = (await mssql('SELECT * FROM dbo.tp_rebates WHERE id=@id', { id })).recordset[0];
  return ok({ rebate: after });
}

// The Review & Close worklist.
async function queue(q, user) {
  const conds = [`rc.status='Open'`];
  const p = {};
  if (q.search) { conds.push('(a.First_Name LIKE @s OR a.Last_Name LIKE @s)'); p.s = `%${q.search}%`; }
  if (q.state === 'deferred') conds.push('rc.deferred_until IS NOT NULL AND rc.deferred_until > CAST(GETDATE() AS date)');
  if (q.state === 'rts') conds.push('rc.rts_flagged=1');
  if (q.state === 'rebate-due') conds.push(`(SELECT COUNT(*) FROM dbo.tp_rebates rb WHERE rb.member_key=rc.member_key AND rb.intake_type=rc.intake_type AND rb.status='Completed') < ${RB.MAX_REBATES}`);
  const rows = (await mssql(`
    SELECT rc.*, mi.outreach_status, mi.ticket_status, mi.priority,
           a.First_Name, a.Last_Name, a.Group_Name, a.indx AS ready_indx,
           (SELECT COUNT(*) FROM dbo.GLP1_ContactLog cl WHERE cl.member_key=rc.member_key AND cl.category=rc.intake_type) AS attempts,
           (SELECT COUNT(*) FROM dbo.tp_rebates rb WHERE rb.member_key=rc.member_key AND rb.intake_type=rc.intake_type AND rb.status='Completed') AS rebates_issued,
           (SELECT TOP 1 o.delivered_date FROM dbo.tp_orders o WHERE o.member_key=rc.member_key AND o.intake_type=rc.intake_type ORDER BY o.delivered_date DESC) AS delivered_date
    FROM dbo.tp_review_close rc
    LEFT JOIN dbo.tp_member_intakes mi ON mi.member_key=rc.member_key AND mi.intake_type=rc.intake_type
    OUTER APPLY (SELECT TOP 1 r.First_Name, r.Last_Name, r.Group_Name, r.indx FROM dbo.ReadyToAssign r
      WHERE r.category=rc.intake_type AND COALESCE(NULLIF(r.Member_ID,''), CAST(r.indx AS VARCHAR(50)))=rc.member_key
      ORDER BY r.indx DESC) a
    WHERE ${conds.join(' AND ')}
    ORDER BY rc.routed_at`, p)).recordset;
  const s = (await mssql(`
    SELECT COUNT(*) open_cases,
           SUM(CASE WHEN rts_flagged=1 THEN 1 ELSE 0 END) rts,
           SUM(CASE WHEN deferred_until IS NOT NULL AND deferred_until > CAST(GETDATE() AS date) THEN 1 ELSE 0 END) deferred
    FROM dbo.tp_review_close WHERE status='Open'`)).recordset[0] || {};
  const rebateDue = rows.filter(r => r.rebates_issued < RB.MAX_REBATES).length;
  return ok({ rows, summary: {
    open_cases: Number(s.open_cases || 0), rts: Number(s.rts || 0),
    deferred: Number(s.deferred || 0), rebate_due: rebateDue } });
}

// CC3 — members flagged for a later retry.
async function recycling(q) {
  const conds = [`mi.outreach_status IN ('Non-Responsive','Invalid Information')`];
  const p = {};
  if (q.search) { conds.push('(a.First_Name LIKE @s OR a.Last_Name LIKE @s)'); p.s = `%${q.search}%`; }
  if (q.due === '1') conds.push('(mi.recycle_after IS NULL OR mi.recycle_after <= CAST(GETDATE() AS date))');
  const rows = (await mssql(`
    SELECT mi.member_key, mi.intake_type, mi.outreach_status, mi.outreach_status_at, mi.recycle_after,
           mi.ticket_status, rc.close_reason, rc.close_detail, rc.authorized_by,
           a.First_Name, a.Last_Name, a.Group_Name, a.indx AS ready_indx,
           (SELECT COUNT(*) FROM dbo.GLP1_ContactLog cl WHERE cl.member_key=mi.member_key AND cl.category=mi.intake_type) AS attempts
    FROM dbo.tp_member_intakes mi
    LEFT JOIN dbo.tp_review_close rc ON rc.member_key=mi.member_key AND rc.intake_type=mi.intake_type
    OUTER APPLY (SELECT TOP 1 r.First_Name, r.Last_Name, r.Group_Name, r.indx FROM dbo.ReadyToAssign r
      WHERE r.category=mi.intake_type AND COALESCE(NULLIF(r.Member_ID,''), CAST(r.indx AS VARCHAR(50)))=mi.member_key
      ORDER BY r.indx DESC) a
    WHERE ${conds.join(' AND ')}
    ORDER BY mi.recycle_after, mi.outreach_status_at DESC`, p)).recordset;
  const summary = {
    total: rows.length,
    non_responsive: rows.filter(r => r.outreach_status === 'Non-Responsive').length,
    invalid: rows.filter(r => r.outreach_status === 'Invalid Information').length,
    due_now: rows.filter(r => !r.recycle_after || new Date(r.recycle_after) <= new Date()).length,
  };
  return ok({ rows, summary });
}

// Rebate worklist — also the Friday export to KC.
async function rebateList(q) {
  const conds = [];
  const p = {};
  if (q.status) { conds.push('rb.status=@st'); p.st = q.status; }
  if (q.rebate_status) { conds.push('rb.rebate_status=@rs'); p.rs = q.rebate_status; }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = (await mssql(`
    SELECT rb.*, a.First_Name, a.Last_Name, a.Group_Name, a.indx AS ready_indx
    FROM dbo.tp_rebates rb
    OUTER APPLY (SELECT TOP 1 r.First_Name, r.Last_Name, r.Group_Name, r.indx FROM dbo.ReadyToAssign r
      WHERE r.category=rb.intake_type AND COALESCE(NULLIF(r.Member_ID,''), CAST(r.indx AS VARCHAR(50)))=rb.member_key
      ORDER BY r.indx DESC) a
    ${where}
    ORDER BY rb.created_at DESC, rb.id DESC`, p)).recordset;
  return ok({ rows, summary: {
    total: rows.length,
    open: rows.filter(r => r.status === 'Open').length,
    unpaid: rows.filter(r => r.rebate_status === 'UNPAID').length,
    maxed: rows.filter(r => r.rebate_status === 'MAXED OUT').length,
  } });
}
