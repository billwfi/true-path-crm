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

const TARGETS  = ['Prescriber', 'Member', 'BA'];
const CHANNELS = ['Fax', 'Call', 'LVM', 'Text', 'Email'];
const GETRX_STATUSES = ['New', 'Faxed', 'Follow-up Call', 'Refaxed', 'MRC Escalation', 'Verbal Request', 'Rx Received'];
const STAGES = ['Get Rx', 'Rx Received', 'Processing', 'Verify Address', 'Ordered'];

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
      if (q.order_id) {
        const order = (await mssql(
          `SELECT o.*, LTRIM(RTRIM(CONCAT(u.firstname,' ',u.lastname))) AS assigned_name
           FROM dbo.tp_orders o LEFT JOIN dbo.Users u ON u.id=o.assigned_to
           WHERE o.id=@id`, { id: parseInt(q.order_id, 10) })).recordset[0];
        if (!order) return notFound();
        const attempts = (await mssql(
          `SELECT * FROM dbo.tp_getrx_attempts WHERE order_id=@id ORDER BY attempt_no, id`,
          { id: order.id })).recordset;
        const nm = await memberName(order.member_key, order.intake_type);
        const scripts = (await mssql(
          `SELECT script_key, title, trigger_point, script_text FROM dbo.tp_getrx_scripts WHERE active=1 ORDER BY sort_order`))
          .recordset.map(s => ({ ...s, script_text: (s.script_text || '').replace(/\{\{\s*first_name\s*\}\}/gi, nm.first || 'there') }));
        return ok({ order, attempts, scripts, member_name: nm.full });
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
