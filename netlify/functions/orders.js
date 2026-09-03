const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');
const { normalizePriority, isEscalation, nextFollowup } = require('./_cadence');

// CC Phase 3 — the order ticket + Get Rx prescriber-chase stage (CC4 + RXF1).
//   GET  /orders?member=&category=            -> orders for a member+intake
//   GET  /orders?order_id=                    -> one order + Get Rx attempts + scripts
//   POST /orders?member=&category=            -> create order ticket (after enrollment)
//   PATCH /orders?order_id=                   -> update order (stage/status/priority/active-Rx/fields/close)
//   POST /orders?order_id=&resource=attempt   -> log a Get Rx outreach attempt
//   POST /orders?order_id=&resource=verbal-handoff  -> verbal Rx request → BA (creates BA ESC reminder)
//   POST /orders?order_id=&resource=mrc-escalation   -> escalate to leadership/MRC
//   POST /orders?order_id=&resource=rx-received      -> mark Rx received (→ Rx processing, increment 2)
//
// Phase 4 (procurement hand-off + shipping/tracking):
//   POST /orders?order_id=&resource=verify-address   -> address verified (→ Verify Address stage)
//   POST /orders?order_id=&resource=handoff          -> hand off to procurement (tp_batch + Registered for Services)
//   POST /orders?order_id=&resource=ship             -> record shipment (carrier + tracking #) + tracking task
//   POST /orders?order_id=&resource=tracking-text    -> compose/log the member tracking text (staged)
//   POST /orders?order_id=&resource=carrier-check    -> log a carrier status check
//   POST /orders?order_id=&resource=delivered        -> mark delivered (+ delivery-confirmation call task)
//   POST /orders?order_id=&resource=delivery-call    -> log the delivery-confirmation call
//   POST /orders?order_id=&resource=delay            -> flag a shipping delay
//   GET  /orders?resource=tracking[&mine=1&state=]   -> shipments in flight / follow-ups due

const TARGETS  = ['Prescriber', 'Member', 'BA'];
const CHANNELS = ['Fax', 'Call', 'LVM', 'Text', 'Email'];
const GETRX_STATUSES = ['New', 'Faxed', 'Follow-up Call', 'Refaxed', 'MRC Escalation', 'Verbal Request', 'Rx Received'];
const STAGES = ['Get Rx', 'Rx Received', 'Processing', 'Verify Address', 'Ordered', 'Shipped', 'Delivered'];

const MEMBER_MATCH = `category=@c AND COALESCE(NULLIF(Member_ID,''), CAST(indx AS VARCHAR(50)))=@m`;

async function memberName(member, cat) {
  const m = (await mssql(
    `SELECT TOP 1 First_Name, Last_Name FROM dbo.ReadyToAssign WHERE ${MEMBER_MATCH} ORDER BY indx DESC`,
    { c: cat, m: member })).recordset[0] || {};
  return {
    first: (m.First_Name || '').trim(),
    full: `${(m.Last_Name || '').trim()}, ${(m.First_Name || '').trim()}`.replace(/^, |, $/, '') || member,
  };
}

// A reminder addressed by name (staff routing = Phase 3+; staff_id left null).
async function makeReminder(relType, desc, when, byUserId) {
  const existing = (await mssql(
    `SELECT TOP 1 id FROM dbo.tp_reminders WHERE rel_type=@rt AND is_closed=0 AND description=@d`,
    { rt: relType, d: desc })).recordset[0];
  if (existing) return false;
  await mssql(
    `INSERT INTO dbo.tp_reminders (rel_type, rel_id, staff_id, created_by, description, reminder_date, notify_by_email, is_closed)
     VALUES (@rt, NULL, NULL, @by, @d, @when, 0, 0)`,
    { rt: relType, by: byUserId || null, d: desc, when });
  return true;
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  const q = event.queryStringParameters || {};
  const cat = q.category || 'GLP1';

  try {
    if (event.httpMethod === 'GET') {
      if (q.resource === 'tracking') return trackingQueue(q, user);
      if (q.order_id) {
        const order = (await mssql(
          `SELECT o.*, LTRIM(RTRIM(CONCAT(u.firstname,' ',u.lastname))) AS assigned_name
           FROM dbo.tp_orders o LEFT JOIN dbo.Users u ON u.id=o.assigned_to
           WHERE o.id=@id`, { id: parseInt(q.order_id, 10) })).recordset[0];
        if (!order) return notFound();
        const attempts = (await mssql(
          `SELECT * FROM dbo.tp_getrx_attempts WHERE order_id=@id ORDER BY attempt_no, id`,
          { id: order.id })).recordset;
        const events = (await mssql(
          `SELECT id, event_type, status, notes, occurred_at FROM dbo.tp_tracking_events
           WHERE order_id=@id ORDER BY occurred_at DESC, id DESC`, { id: order.id })).recordset;
        const nm = await memberName(order.member_key, order.intake_type);
        const scripts = (await mssql(
          `SELECT script_key, title, trigger_point, script_text FROM dbo.tp_getrx_scripts WHERE active=1 ORDER BY sort_order`))
          .recordset.map(s => ({ ...s, script_text: (s.script_text || '').replace(/\{\{\s*first_name\s*\}\}/gi, nm.first || 'there') }));
        // Tracking text, with the member's name / tracking number filled in.
        const tt = (await mssql(
          `SELECT TOP 1 script_text FROM dbo.tp_outreach_scripts WHERE intake_type='*' AND attempt_no=-1`)).recordset[0];
        const trackingText = tt ? fillTracking(tt.script_text, nm.first, order) : null;
        return ok({ order, attempts, events, scripts, member_name: nm.full, tracking_text: trackingText });
      }
      if (!q.member) return badRequest('member or order_id required');
      const orders = (await mssql(
        `SELECT o.id, o.medication, o.strength, o.day_supply, o.stage, o.getrx_status, o.priority,
                o.active_rx_checked, o.active_rx_found, o.closed, o.created_at,
                (SELECT COUNT(*) FROM dbo.tp_getrx_attempts a WHERE a.order_id=o.id) AS attempts
         FROM dbo.tp_orders o WHERE o.member_key=@m AND o.intake_type=@c
         ORDER BY o.closed, o.created_at DESC`, { m: q.member, c: cat })).recordset;
      return ok({ orders });
    }

    if (event.httpMethod === 'POST') {
      if (q.resource === 'attempt') return logAttempt(q, event, user);
      if (q.resource === 'verbal-handoff') return verbalHandoff(q, event, user);
      if (q.resource === 'mrc-escalation') return mrcEscalation(q, user);
      if (q.resource === 'rx-received') return markRxReceived(q, user);
      if (q.resource === 'verify-address') return verifyAddress(q, user);
      if (q.resource === 'handoff') return procurementHandoff(q, event, user);
      if (q.resource === 'ship') return recordShipment(q, event, user);
      if (q.resource === 'tracking-text') return trackingText(q, user);
      if (q.resource === 'carrier-check') return carrierCheck(q, event, user);
      if (q.resource === 'delivered') return markDelivered(q, event, user);
      if (q.resource === 'delivery-call') return deliveryCall(q, event, user);
      if (q.resource === 'delay') return reportDelay(q, event, user);

      // Create an order ticket for a member+intake.
      if (!q.member) return badRequest('member is required');
      const b = JSON.parse(event.body || '{}');
      // Assign to whoever holds the member for this intake.
      const asg = (await mssql(
        `SELECT TOP 1 assigned_to FROM dbo.ReadyToAssign
         WHERE ${MEMBER_MATCH} AND assigned_to IS NOT NULL ORDER BY assigned_at DESC, indx DESC`,
        { c: cat, m: q.member })).recordset[0];
      const r = await mssql(
        `INSERT INTO dbo.tp_orders
           (member_key, intake_type, medication, strength, day_supply, supply_on_hand, enrollment_notes,
            stage, getrx_status, priority, assigned_to, created_by, updated_at)
         OUTPUT INSERTED.id
         VALUES (@member, @category, @medication, @strength, @day_supply, @supply_on_hand, @notes,
            'Get Rx', 'New', @priority, @assigned_to, @by, SYSUTCDATETIME())`,
        {
          member: q.member, category: cat,
          medication: (b.medication || '').slice(0, 200) || null,
          strength: (b.strength || '').slice(0, 100) || null,
          day_supply: b.day_supply != null && b.day_supply !== '' ? parseInt(b.day_supply, 10) : null,
          supply_on_hand: (b.supply_on_hand || '').slice(0, 100) || null,
          notes: b.enrollment_notes || null,
          priority: normalizePriority(b.priority),
          assigned_to: (asg && asg.assigned_to) || null, by: user.id || null,
        });
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      const id = parseInt(q.order_id, 10);
      if (!id) return badRequest('order_id required');
      const cur = (await mssql('SELECT * FROM dbo.tp_orders WHERE id=@id', { id })).recordset[0];
      if (!cur) return notFound();
      const b = JSON.parse(event.body || '{}');

      const sets = [], p = { id };
      const setIf = (key, col, tx) => { if (key in b) { sets.push(`${col}=@${col}`); p[col] = tx ? tx(b[key]) : b[key]; } };
      setIf('medication', 'medication', v => (v || '').slice(0, 200) || null);
      setIf('strength', 'strength', v => (v || '').slice(0, 100) || null);
      setIf('day_supply', 'day_supply', v => (v === '' || v == null ? null : parseInt(v, 10)));
      setIf('supply_on_hand', 'supply_on_hand', v => (v || '').slice(0, 100) || null);
      setIf('enrollment_notes', 'enrollment_notes', v => v || null);
      if ('stage' in b) { sets.push('stage=@stage'); p.stage = STAGES.includes(b.stage) ? b.stage : cur.stage; }
      if ('getrx_status' in b) { sets.push('getrx_status=@getrx_status'); p.getrx_status = GETRX_STATUSES.includes(b.getrx_status) ? b.getrx_status : cur.getrx_status; }
      if ('priority' in b) { sets.push('priority=@priority'); p.priority = normalizePriority(b.priority); }
      setIf('active_rx_checked', 'active_rx_checked', v => v ? 1 : 0);
      if ('active_rx_found' in b) { sets.push('active_rx_found=@active_rx_found'); p.active_rx_found = b.active_rx_found == null ? null : (b.active_rx_found ? 1 : 0); }
      setIf('closed', 'closed', v => v ? 1 : 0);
      if (!sets.length) return badRequest('no updatable fields');
      sets.push('updated_at=SYSUTCDATETIME()');
      await mssql(`UPDATE dbo.tp_orders SET ${sets.join(', ')} WHERE id=@id`, p);

      // Escalation reminder on transition into High/Urgent or MRC Escalation.
      let escalated = false;
      const newPr = 'priority' in b ? normalizePriority(b.priority) : normalizePriority(cur.priority);
      const roseToEsc = isEscalation(newPr) && !isEscalation(cur.priority);
      const toMrc = b.getrx_status === 'MRC Escalation' && cur.getrx_status !== 'MRC Escalation';
      if (roseToEsc || toMrc) {
        const nm = await memberName(cur.member_key, cur.intake_type);
        escalated = await makeReminder('Get Rx Escalation',
          `ESC - Get Rx - ${nm.full} - ${toMrc ? 'MRC Escalation' : newPr}`,
          nextFollowup(newPr) + 'T09:00:00', user.id);
      }
      return ok({ ok: true, escalated });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};

// Log a Get Rx outreach attempt; auto-advance status + schedule the next follow-up.
async function logAttempt(q, event, user) {
  const id = parseInt(q.order_id, 10);
  if (!id) return badRequest('order_id required');
  const cur = (await mssql('SELECT * FROM dbo.tp_orders WHERE id=@id', { id })).recordset[0];
  if (!cur) return notFound();
  const b = JSON.parse(event.body || '{}');
  const target = TARGETS.includes(b.target) ? b.target : 'Prescriber';
  const channel = CHANNELS.includes(b.channel) ? b.channel : 'Call';
  const priority = normalizePriority(cur.priority);

  const n = (await mssql('SELECT ISNULL(MAX(attempt_no),0)+1 AS n FROM dbo.tp_getrx_attempts WHERE order_id=@id', { id })).recordset[0].n;
  const turnaround = b.turnaround_days != null && b.turnaround_days !== '' ? parseInt(b.turnaround_days, 10) : null;
  // Follow-up: explicit > prescriber turnaround (days from today) > priority cadence.
  const addDays = d => { const x = new Date(); x.setDate(x.getDate() + d); return x.toISOString().slice(0, 10); };
  const followup = b.followup_date || (turnaround != null && !isNaN(turnaround) ? addDays(turnaround) : nextFollowup(priority));

  const row = (await mssql(
    `INSERT INTO dbo.tp_getrx_attempts
       (order_id, attempt_no, target, channel, phone_tree, turnaround_days, notes, outcome, followup_date, created_by)
     OUTPUT INSERTED.*
     VALUES (@id, @n, @target, @channel, @phone_tree, @turnaround, @notes, @outcome, @followup, @by)`,
    { id, n, target, channel, phone_tree: (b.phone_tree || '').slice(0, 80) || null,
      turnaround, notes: b.notes || null, outcome: (b.outcome || '').slice(0, 80) || null,
      followup: followup || null, by: user.id || null })).recordset[0];

  // Light status auto-advance (never rolls back a further-along status).
  const order = ['New', 'Faxed', 'Follow-up Call', 'Refaxed'];
  let implied = cur.getrx_status;
  if (channel === 'Fax') implied = n === 1 ? 'Faxed' : 'Refaxed';
  else if (channel === 'Call' || channel === 'LVM') implied = 'Follow-up Call';
  if (implied && order.indexOf(implied) > order.indexOf(cur.getrx_status || 'New')) {
    await mssql('UPDATE dbo.tp_orders SET getrx_status=@s, updated_at=SYSUTCDATETIME() WHERE id=@id', { s: implied, id });
  }
  return created({ attempt: row, attempt_no: n, followup_date: followup, getrx_status_hint: implied });
}

async function verbalHandoff(q, event, user) {
  const id = parseInt(q.order_id, 10);
  if (!id) return badRequest('order_id required');
  const cur = (await mssql('SELECT * FROM dbo.tp_orders WHERE id=@id', { id })).recordset[0];
  if (!cur) return notFound();
  const nm = await memberName(cur.member_key, cur.intake_type);
  const n = (await mssql('SELECT ISNULL(MAX(attempt_no),0)+1 AS n FROM dbo.tp_getrx_attempts WHERE order_id=@id', { id })).recordset[0].n;
  await mssql(
    `INSERT INTO dbo.tp_getrx_attempts (order_id, attempt_no, target, channel, notes, outcome, created_by)
     VALUES (@id, @n, 'BA', 'Other', @notes, 'Verbal Rx request to BA', @by)`,
    { id, n, notes: 'Verbal Rx request handed to BA for Cypress submission', by: user.id || null });
  await mssql(`UPDATE dbo.tp_orders SET getrx_status='Verbal Request', updated_at=SYSUTCDATETIME() WHERE id=@id`, { id });
  const escalated = await makeReminder('CC Escalation',
    `ESC - Verbal Rx Request - ${nm.full}`, nextFollowup(normalizePriority(cur.priority)) + 'T09:00:00', user.id);
  return ok({ ok: true, getrx_status: 'Verbal Request', ba_reminder: escalated });
}

async function mrcEscalation(q, user) {
  const id = parseInt(q.order_id, 10);
  if (!id) return badRequest('order_id required');
  const cur = (await mssql('SELECT * FROM dbo.tp_orders WHERE id=@id', { id })).recordset[0];
  if (!cur) return notFound();
  await mssql(`UPDATE dbo.tp_orders SET getrx_status='MRC Escalation', updated_at=SYSUTCDATETIME() WHERE id=@id`, { id });
  const nm = await memberName(cur.member_key, cur.intake_type);
  const escalated = await makeReminder('Get Rx Escalation',
    `ESC - Get Rx - ${nm.full} - MRC Escalation`, nextFollowup(normalizePriority(cur.priority)) + 'T09:00:00', user.id);
  return ok({ ok: true, getrx_status: 'MRC Escalation', escalated });
}

async function markRxReceived(q, user) {
  const id = parseInt(q.order_id, 10);
  if (!id) return badRequest('order_id required');
  const r = await mssql(
    `UPDATE dbo.tp_orders SET getrx_status='Rx Received', stage='Rx Received', updated_at=SYSUTCDATETIME()
     WHERE id=@id`, { id });
  return r.rowsAffected[0] ? ok({ ok: true, stage: 'Rx Received' }) : notFound();
}

/* ══════════ Phase 4 — procurement hand-off + shipping / tracking ══════════ */

// USPS/UPS/FedEx public tracking URL for the member text.
function carrierLink(carrier, tn) {
  if (!tn) return '';
  const c = (carrier || '').toUpperCase();
  if (c.includes('UPS'))   return `https://www.ups.com/track?tracknum=${encodeURIComponent(tn)}`;
  if (c.includes('FEDEX')) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(tn)}`;
  return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(tn)}`;
}
function fillTracking(text, first, o) {
  return (text || '')
    .replace(/\{\{\s*first_name\s*\}\}/gi, first || 'there')
    .replace(/\{\{\s*tracking_number\s*\}\}/gi, o.tracking_number || '[tracking #]')
    .replace(/\{\{\s*tracking_link\s*\}\}/gi, carrierLink(o.carrier, o.tracking_number) || '[tracking link]');
}
async function logEvent(orderId, type, status, notes, userId) {
  await mssql(
    `INSERT INTO dbo.tp_tracking_events (order_id, event_type, status, notes, created_by)
     VALUES (@id, @t, @s, @n, @by)`,
    { id: orderId, t: type, s: (status || '').slice(0, 120) || null, n: notes || null, by: userId || null });
}
async function getOrder(id) {
  return (await mssql('SELECT * FROM dbo.tp_orders WHERE id=@id', { id })).recordset[0];
}

// RC2 — the SOP reminder ladder off the order's run-out date.
async function orderTaskReminders(o, nm, userId) {
  const made = [];
  const med = [o.medication, o.strength].filter(Boolean).join(' ') || 'medication';
  // The per-medication order task: due at run-out, with the SOP checklist.
  const rebate = (o.rebate_monthly != null || o.rebate_annual != null)
    ? ` — ${med} $${o.rebate_monthly ?? 0}/mo${o.rebate_annual != null ? ` / $${o.rebate_annual}/yr` : ''}`
    : '';
  const taskName = `Order - ${med}${o.day_supply ? ` - ${o.day_supply} day` : ''}${rebate}`;
  const desc = 'Checklist: (1) Submit Order Form  (2) Place Order';
  await mssql(
    `INSERT INTO dbo.tp_tasks (name, status, priority, start_date, due_date, assigned_id, related_type, related_id, description, tags)
     VALUES (@n, 'Open', @p, CAST(GETDATE() AS date), @due, @asg, 'CC Order', @rid, @d, 'Scripts')`,
    { n: taskName.slice(0, 1000), p: o.priority || 'Medium', due: o.run_out_date || null,
      asg: o.assigned_to || null, rid: o.id, d: desc });
  made.push(taskName);
  // Rx-driven reminders, only when we know the run-out date. run_out_date arrives from
  // the driver as a Date; String()-slicing it yields "Sun Nov 15", which new Date()
  // reads as year 2001 — so normalise to a real UTC date and step back in UTC.
  if (o.run_out_date) {
    const base = (o.run_out_date instanceof Date)
      ? new Date(Date.UTC(o.run_out_date.getUTCFullYear(), o.run_out_date.getUTCMonth(), o.run_out_date.getUTCDate()))
      : new Date(String(o.run_out_date).slice(0, 10) + 'T00:00:00Z');
    const dayBefore = n => {
      const x = new Date(base);
      x.setUTCDate(x.getUTCDate() - n);
      return x.toISOString().slice(0, 10);
    };
    const ladder = [
      [45, `Get Rx - ${nm.full} - ${med}`],
      [23, `Submit to verify address - ${nm.full} - ${med}`],
      [25, `Adjudication (WellDyne/BevCap) - ${nm.full} - ${med}`],
    ];
    for (const [days, text] of ladder) {
      await mssql(
        `INSERT INTO dbo.tp_reminders (rel_type, rel_id, staff_id, created_by, description, reminder_date, notify_by_email, is_closed)
         VALUES ('CC Order', @rid, NULL, @by, @d, @when, 0, 0)`,
        { rid: o.id, by: userId || null, d: text.slice(0, 400), when: dayBefore(days) + 'T09:00:00' });
      made.push(text);
    }
  }
  return made;
}

async function verifyAddress(q, user) {
  const id = parseInt(q.order_id, 10);
  if (!id) return badRequest('order_id required');
  const o = await getOrder(id); if (!o) return notFound();
  await mssql(
    `UPDATE dbo.tp_orders SET address_verified=1, address_verified_at=SYSUTCDATETIME(),
       stage=CASE WHEN stage IN ('Get Rx','Rx Received','Processing') THEN 'Verify Address' ELSE stage END,
       updated_at=SYSUTCDATETIME() WHERE id=@id`, { id });
  return ok({ ok: true, address_verified: true });
}

// IA5 — hand off to procurement: create the tp_batch record, mark the intake
// 'Registered for Services', and raise a procurement notification.
async function procurementHandoff(q, event, user) {
  const id = parseInt(q.order_id, 10);
  if (!id) return badRequest('order_id required');
  const o = await getOrder(id); if (!o) return notFound();
  if (!o.address_verified) return badRequest('Verify the shipping address before handing off to procurement');
  if (o.batch_id) return badRequest('This order has already been handed off (batch #' + o.batch_id + ')');
  const b = JSON.parse(event.body || '{}');
  const nm = await memberName(o.member_key, o.intake_type);

  const batch = await mssql(
    `INSERT INTO dbo.tp_batch (customer_id, customer_name, drug_name, strength, vendor,
        vendor_day_supply, status, transaction_date, document_patient_id)
     OUTPUT INSERTED.id
     VALUES (@cid, @cname, @drug, @strength, @vendor, @ds, 'Pending', CAST(GETDATE() AS date), @cid)`,
    { cid: o.member_key, cname: nm.full, drug: o.medication, strength: o.strength,
      vendor: (b.vendor || '').slice(0, 500) || null, ds: o.day_supply || null });
  const batchId = batch.recordset[0].id;

  await mssql(
    `UPDATE dbo.tp_orders SET batch_id=@bid, handed_off_at=SYSUTCDATETIME(), stage='Ordered',
       rebate_group=COALESCE(@rg, rebate_group), rebate_monthly=COALESCE(@rm, rebate_monthly),
       rebate_annual=COALESCE(@ra, rebate_annual), run_out_date=COALESCE(@ro, run_out_date),
       updated_at=SYSUTCDATETIME() WHERE id=@id`,
    { bid: batchId, id,
      rg: (b.rebate_group || '').slice(0, 120) || null,
      rm: b.rebate_monthly !== '' && b.rebate_monthly != null ? Number(b.rebate_monthly) : null,
      ra: b.rebate_annual !== '' && b.rebate_annual != null ? Number(b.rebate_annual) : null,
      ro: b.run_out_date || null });

  // IA5 — terminal intake state signalling "ready for procurement".
  await mssql(
    `UPDATE dbo.tp_member_intakes SET status='Registered for Services', sub_status='Order Created',
       status_date=CAST(GETDATE() AS date), updated_by=@by, updated_at=GETDATE()
     WHERE member_key=@m AND intake_type=@c`,
    { m: o.member_key, c: o.intake_type, by: user.id || null });

  await makeReminder('Procurement Hand-off',
    `PROCUREMENT - ${nm.full} - ${[o.medication, o.strength].filter(Boolean).join(' ')} - batch #${batchId}`,
    nextFollowup('High') + 'T09:00:00', user.id);

  // RC2 — order task + Rx-driven reminder ladder.
  const fresh = await getOrder(id);
  const tasks = await orderTaskReminders(fresh, nm, user.id);
  await logEvent(id, 'Hand-off', 'Handed to procurement', `Batch #${batchId}`, user.id);
  return ok({ ok: true, batch_id: batchId, stage: 'Ordered', intake_status: 'Registered for Services', created: tasks });
}

// CC5 — record the shipment and open the tracking task.
async function recordShipment(q, event, user) {
  const id = parseInt(q.order_id, 10);
  if (!id) return badRequest('order_id required');
  const o = await getOrder(id); if (!o) return notFound();
  const b = JSON.parse(event.body || '{}');
  const tn = (b.tracking_number || '').trim();
  if (!tn) return badRequest('tracking_number is required');
  const carrier = (b.carrier || 'USPS').slice(0, 60);
  await mssql(
    `UPDATE dbo.tp_orders SET carrier=@carrier, tracking_number=@tn, shipped_date=@sd,
       stage='Shipped', delay_flag=0, updated_at=SYSUTCDATETIME() WHERE id=@id`,
    { carrier, tn: tn.slice(0, 120), sd: b.shipped_date || new Date().toISOString().slice(0, 10), id });
  await logEvent(id, 'Shipped', `${carrier} ${tn}`, b.notes || null, user.id);
  const nm = await memberName(o.member_key, o.intake_type);
  // Tracking task for the rep to monitor the carrier until delivery.
  await mssql(
    `INSERT INTO dbo.tp_tasks (name, status, priority, start_date, assigned_id, related_type, related_id, description, tags)
     VALUES (@n, 'Open', @p, CAST(GETDATE() AS date), @asg, 'CC Tracking', @rid, @d, 'Tracking')`,
    { n: `Tracking - ${nm.full} - ${carrier} ${tn}`.slice(0, 1000), p: o.priority || 'Medium',
      asg: o.assigned_to || null, rid: id,
      d: `Monitor ${carrier} until delivered, then make the delivery-confirmation call.` });
  const fresh = await getOrder(id);
  return created({ ok: true, stage: 'Shipped', tracking_link: carrierLink(carrier, tn),
    tracking_text: fillTracking((await mssql(`SELECT TOP 1 script_text FROM dbo.tp_outreach_scripts WHERE intake_type='*' AND attempt_no=-1`)).recordset[0]?.script_text, nm.first, fresh) });
}

// CC5 — staged member tracking text (composed + logged, not dispatched).
async function trackingText(q, user) {
  const id = parseInt(q.order_id, 10);
  if (!id) return badRequest('order_id required');
  const o = await getOrder(id); if (!o) return notFound();
  if (!o.tracking_number) return badRequest('Record the shipment first');
  const nm = await memberName(o.member_key, o.intake_type);
  const tpl = (await mssql(`SELECT TOP 1 script_text FROM dbo.tp_outreach_scripts WHERE intake_type='*' AND attempt_no=-1`)).recordset[0];
  const msg = fillTracking(tpl && tpl.script_text, nm.first, o);
  await mssql('UPDATE dbo.tp_orders SET tracking_texted_at=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME() WHERE id=@id', { id });
  await logEvent(id, 'Tracking Texted', 'Prepared [staged]', msg, user.id);
  // Mirror into the contact log so the member's history shows it.
  await mssql(
    `INSERT INTO dbo.GLP1_ContactLog (member_key, category, contact_date, contact_type, notes, contact_status, created_by)
     VALUES (@m, @c, CAST(GETDATE() AS date), 'Text', @n, 'Closed', @by)`,
    { m: o.member_key, c: o.intake_type, n: 'Tracking text prepared [staged]', by: user.id || null });
  return ok({ ok: true, message: msg, staged: true });
}

async function carrierCheck(q, event, user) {
  const id = parseInt(q.order_id, 10);
  if (!id) return badRequest('order_id required');
  const b = JSON.parse(event.body || '{}');
  const status = (b.status || '').trim();
  if (!status) return badRequest('status is required');
  await mssql(
    `UPDATE dbo.tp_orders SET last_carrier_status=@s, last_carrier_check=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME() WHERE id=@id`,
    { s: status.slice(0, 120), id });
  await logEvent(id, 'Carrier Check', status, b.notes || null, user.id);
  return ok({ ok: true, last_carrier_status: status });
}

// CC5 — delivered: stamp the date and open the delivery-confirmation call step.
async function markDelivered(q, event, user) {
  const id = parseInt(q.order_id, 10);
  if (!id) return badRequest('order_id required');
  const o = await getOrder(id); if (!o) return notFound();
  const b = JSON.parse(event.body || '{}');
  const dd = b.delivered_date || new Date().toISOString().slice(0, 10);
  await mssql(
    `UPDATE dbo.tp_orders SET delivered_date=@dd, stage='Delivered', delay_flag=0,
       last_carrier_status='Delivered', last_carrier_check=SYSUTCDATETIME(), updated_at=SYSUTCDATETIME()
     WHERE id=@id`, { dd, id });
  await logEvent(id, 'Delivered', 'Delivered', b.notes || null, user.id);
  const nm = await memberName(o.member_key, o.intake_type);
  const made = await makeReminder('Delivery Confirmation',
    `DELIVERY CALL - ${nm.full} - confirm receipt`, new Date().toISOString().slice(0, 10) + 'T09:00:00', user.id);
  return ok({ ok: true, stage: 'Delivered', delivery_call_reminder: made });
}

async function deliveryCall(q, event, user) {
  const id = parseInt(q.order_id, 10);
  if (!id) return badRequest('order_id required');
  const b = JSON.parse(event.body || '{}');
  await mssql(
    `UPDATE dbo.tp_orders SET delivery_confirmed=1, delivery_confirmed_at=SYSUTCDATETIME(),
       closed=CASE WHEN @close=1 THEN 1 ELSE closed END, updated_at=SYSUTCDATETIME() WHERE id=@id`,
    { id, close: b.close_order ? 1 : 0 });
  await logEvent(id, 'Delivery Call', b.reached ? 'Member reached' : 'No answer', b.notes || null, user.id);
  const o = await getOrder(id);
  // Log the call on the member's contact history too.
  await mssql(
    `INSERT INTO dbo.GLP1_ContactLog (member_key, category, contact_date, contact_type, notes, contact_status, created_by)
     VALUES (@m, @c, CAST(GETDATE() AS date), 'Phone Call', @n, @st, @by)`,
    { m: o.member_key, c: o.intake_type,
      n: `Delivery-confirmation call — ${b.reached ? 'member reached' : 'no answer'}${b.notes ? ': ' + b.notes : ''}`,
      st: b.reached ? 'Closed' : 'Open', by: user.id || null });
  return ok({ ok: true, delivery_confirmed: true, closed: !!b.close_order });
}

async function reportDelay(q, event, user) {
  const id = parseInt(q.order_id, 10);
  if (!id) return badRequest('order_id required');
  const o = await getOrder(id); if (!o) return notFound();
  const b = JSON.parse(event.body || '{}');
  const reason = (b.reason || 'Shipping delay').trim();
  await mssql(
    `UPDATE dbo.tp_orders SET delay_flag=1, delay_notes=@n, updated_at=SYSUTCDATETIME() WHERE id=@id`,
    { n: reason + (b.notes ? ` — ${b.notes}` : ''), id });
  await logEvent(id, 'Delay', reason, b.notes || null, user.id);
  const nm = await memberName(o.member_key, o.intake_type);
  const made = await makeReminder('Shipping Delay',
    `DELAY - ${nm.full} - ${reason}`.slice(0, 400), nextFollowup('High') + 'T09:00:00', user.id);
  return ok({ ok: true, delay_flag: true, reminder: made });
}

// Shipments in flight + delivery follow-ups due — the Tracking queue page.
async function trackingQueue(q, user) {
  const conds = [`o.stage IN ('Ordered','Shipped','Delivered')`, 'o.closed=0'];
  const p = { uid: user.id };
  if (q.mine === '1') conds.push('o.assigned_to=@uid');
  if (q.state === 'in-flight')  conds.push(`o.stage='Shipped'`);
  if (q.state === 'awaiting')   conds.push(`o.stage='Ordered'`);
  if (q.state === 'to-confirm') conds.push(`o.stage='Delivered' AND o.delivery_confirmed=0`);
  if (q.state === 'delayed')    conds.push('o.delay_flag=1');
  if (q.search) { conds.push('(a.First_Name LIKE @s OR a.Last_Name LIKE @s OR o.tracking_number LIKE @s OR o.medication LIKE @s)'); p.s = `%${q.search}%`; }
  const rows = (await mssql(`
    SELECT o.id AS order_id, o.member_key, o.intake_type, o.medication, o.strength, o.stage,
           o.carrier, o.tracking_number, o.shipped_date, o.delivered_date, o.delivery_confirmed,
           o.tracking_texted_at, o.last_carrier_status, o.last_carrier_check, o.delay_flag,
           o.batch_id, o.priority, o.run_out_date,
           LTRIM(RTRIM(CONCAT(u.firstname,' ',u.lastname))) AS assigned_name,
           a.First_Name, a.Last_Name, a.Group_Name, a.indx AS ready_indx
    FROM dbo.tp_orders o
    LEFT JOIN dbo.Users u ON u.id=o.assigned_to
    OUTER APPLY (SELECT TOP 1 r.First_Name, r.Last_Name, r.Group_Name, r.indx FROM dbo.ReadyToAssign r
      WHERE r.category=o.intake_type
        AND COALESCE(NULLIF(r.Member_ID,''), CAST(r.indx AS VARCHAR(50)))=o.member_key
      ORDER BY r.indx DESC) a
    WHERE ${conds.join(' AND ')}
    ORDER BY CASE o.stage WHEN 'Delivered' THEN 0 WHEN 'Shipped' THEN 1 ELSE 2 END,
             o.delay_flag DESC, o.shipped_date DESC, o.id DESC`, p)).recordset;
  const s = (await mssql(`
    SELECT SUM(CASE WHEN stage='Ordered' THEN 1 ELSE 0 END) awaiting,
           SUM(CASE WHEN stage='Shipped' THEN 1 ELSE 0 END) in_flight,
           SUM(CASE WHEN stage='Delivered' AND delivery_confirmed=0 THEN 1 ELSE 0 END) to_confirm,
           SUM(CASE WHEN delay_flag=1 THEN 1 ELSE 0 END) delayed
    FROM dbo.tp_orders WHERE closed=0 ${q.mine === '1' ? 'AND assigned_to=@uid' : ''}`, p)).recordset[0] || {};
  return ok({ rows, summary: {
    awaiting: Number(s.awaiting || 0), in_flight: Number(s.in_flight || 0),
    to_confirm: Number(s.to_confirm || 0), delayed: Number(s.delayed || 0) } });
}
