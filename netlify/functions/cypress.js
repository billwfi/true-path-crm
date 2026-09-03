const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');
const { nextFollowup } = require('./_cadence');

// CC Phase 3 increment 3 — Cypress coordination (CS3 + RXF4 + CS4 stats).
//   GET  /cypress?member=&category=            -> requests for a member+intake
//   GET  /cypress?id=                          -> one request
//   GET  /cypress?resource=cover-sheet&id=     -> request + Cypress facility details (for the fax cover sheet)
//   GET  /cypress?resource=scripts             -> Cypress scripts (EN/ES)
//   GET  /cypress?resource=stats&from=&to=[&mine=1] -> daily Rx-received + Cypress-request counts
//   POST /cypress?member=&category=            -> create a request (auto BA ESC reminder)
//   PATCH /cypress?id=                         -> update status/fields
//   DELETE /cypress?id=

const TYPES = ['Transfer In', 'Transfer Out', 'Verbal Request'];
const STATUSES = ['Submitted', 'Sent to Cypress', 'Completed'];

// Cypress Pharmacy facility details (RXF4 cover-sheet spec).
const CYPRESS = {
  name: 'Cypress Pharmacy',
  fax: '832-510-4003',
  phone: '877-546-6378',
  address: '9511 Huffmeister Rd Ste 104, Houston, TX 77095',
  refill_language: '90-day mail-order refill request',
};

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  const q = event.queryStringParameters || {};
  const cat = q.category || 'GLP1';

  try {
    if (event.httpMethod === 'GET') {
      if (q.resource === 'scripts') {
        const rows = (await mssql(
          `SELECT script_key, title, lang, script_text FROM dbo.tp_getrx_scripts
           WHERE active=1 AND trigger_point='cypress' ORDER BY sort_order`)).recordset;
        return ok({ scripts: rows });
      }
      if (q.resource === 'stats') return stats(q, user);
      if (q.resource === 'cover-sheet') {
        const id = parseInt(q.id, 10);
        if (!id) return badRequest('id required');
        const r = (await mssql('SELECT * FROM dbo.tp_cypress_requests WHERE id=@id', { id })).recordset[0];
        if (!r) return notFound();
        return ok({ request: r, cypress: CYPRESS });
      }
      if (q.id) {
        const r = (await mssql('SELECT * FROM dbo.tp_cypress_requests WHERE id=@id', { id: parseInt(q.id, 10) })).recordset[0];
        return r ? ok(r) : notFound();
      }
      if (!q.member) return badRequest('member or id required');
      const rows = (await mssql(
        `SELECT * FROM dbo.tp_cypress_requests WHERE member_key=@m AND intake_type=@c ORDER BY created_at DESC, id DESC`,
        { m: q.member, c: cat })).recordset;
      return ok({ requests: rows, cypress: CYPRESS });
    }

    if (event.httpMethod === 'POST') {
      if (!q.member) return badRequest('member is required');
      const b = JSON.parse(event.body || '{}');
      const type = TYPES.includes(b.request_type) ? b.request_type : null;
      if (!type) return badRequest('request_type must be one of: ' + TYPES.join(', '));

      const r = await mssql(
        `INSERT INTO dbo.tp_cypress_requests
           (member_key, intake_type, order_id, request_type, member_name, dob, phone, address,
            medication, strength, pharmacy_name, pharmacy_address, pharmacy_phone, pharmacy_fax,
            supply_on_hand, never_filled, prescriber_name, prescriber_phone, rx_file_link, status, notes, created_by, updated_at)
         OUTPUT INSERTED.*
         VALUES (@m, @c, @order_id, @type, @member_name, @dob, @phone, @address,
            @medication, @strength, @pharmacy_name, @pharmacy_address, @pharmacy_phone, @pharmacy_fax,
            @supply_on_hand, @never_filled, @prescriber_name, @prescriber_phone, @rx_file_link, 'Submitted', @notes, @by, SYSUTCDATETIME())`,
        {
          m: q.member, c: cat, order_id: b.order_id ? parseInt(b.order_id, 10) : null, type,
          member_name: s(b.member_name, 200), dob: s(b.dob, 20), phone: s(b.phone, 40), address: s(b.address, 300),
          medication: s(b.medication, 200), strength: s(b.strength, 100),
          pharmacy_name: s(b.pharmacy_name, 200), pharmacy_address: s(b.pharmacy_address, 300),
          pharmacy_phone: s(b.pharmacy_phone, 40), pharmacy_fax: s(b.pharmacy_fax, 40),
          supply_on_hand: s(b.supply_on_hand, 100), never_filled: b.never_filled ? 1 : 0,
          prescriber_name: s(b.prescriber_name, 200), prescriber_phone: s(b.prescriber_phone, 40),
          rx_file_link: s(b.rx_file_link, 1000), notes: b.notes || null, by: user.id || null,
        });

      // RXF4 — BA is the sole channel to Cypress: raise a BA ESC reminder on submission.
      const nm = (b.member_name || q.member).trim();
      const desc = `ESC - Pharmacy ${type} - ${nm}`;
      const exists = (await mssql(
        `SELECT TOP 1 id FROM dbo.tp_reminders WHERE rel_type='Cypress Request' AND is_closed=0 AND description=@d`,
        { d: desc })).recordset[0];
      let ba_reminder = false;
      if (!exists) {
        await mssql(
          `INSERT INTO dbo.tp_reminders (rel_type, rel_id, staff_id, created_by, description, reminder_date, notify_by_email, is_closed)
           VALUES ('Cypress Request', @rid, NULL, @by, @d, @when, 0, 0)`,
          { rid: r.recordset[0].id, by: user.id || null, d: desc, when: nextFollowup('High') + 'T09:00:00' });
        ba_reminder = true;
      }
      return created({ request: r.recordset[0], ba_reminder });
    }

    if (event.httpMethod === 'PATCH') {
      const id = parseInt(q.id, 10);
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      const sets = [], p = { id };
      const map = { member_name:200, dob:20, phone:40, address:300, medication:200, strength:100,
        pharmacy_name:200, pharmacy_address:300, pharmacy_phone:40, pharmacy_fax:40, supply_on_hand:100,
        prescriber_name:200, prescriber_phone:40, rx_file_link:1000 };
      for (const [k, len] of Object.entries(map)) if (k in b) { sets.push(`${k}=@${k}`); p[k] = s(b[k], len); }
      if ('never_filled' in b) { sets.push('never_filled=@never_filled'); p.never_filled = b.never_filled ? 1 : 0; }
      if ('notes' in b) { sets.push('notes=@notes'); p.notes = b.notes || null; }
      if ('status' in b) { sets.push('status=@status'); p.status = STATUSES.includes(b.status) ? b.status : 'Submitted'; }
      if (!sets.length) return badRequest('no updatable fields');
      sets.push('updated_at=SYSUTCDATETIME()');
      await mssql(`UPDATE dbo.tp_cypress_requests SET ${sets.join(', ')} WHERE id=@id`, p);
      return ok({ ok: true });
    }

    if (event.httpMethod === 'DELETE') {
      const id = parseInt(q.id, 10);
      if (!id) return badRequest('id required');
      const r = await mssql('DELETE FROM dbo.tp_cypress_requests WHERE id=@id', { id });
      return r.rowsAffected[0] ? ok({ deleted: true }) : notFound();
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};

function s(v, len) { const t = (v == null ? '' : String(v)).trim(); return t ? t.slice(0, len) : null; }

// Daily counts of Rx received (tp_rx_records) and Cypress requests (tp_cypress_requests)
// over a date range; the front end buckets into Mon-Thu week grids for the stats sheet.
async function stats(q, user) {
  const from = q.from || new Date(Date.now() - 28 * 864e5).toISOString().slice(0, 10);
  const to = q.to || new Date().toISOString().slice(0, 10);
  const mineRx = q.mine === '1' ? 'AND o.assigned_to=@uid' : '';
  const p = { from, to, uid: user.id };
  const rx = (await mssql(
    `SELECT CAST(r.created_at AS date) AS d, COUNT(*) AS n
     FROM dbo.tp_rx_records r LEFT JOIN dbo.tp_orders o ON o.id=r.order_id
     WHERE CAST(r.created_at AS date) BETWEEN @from AND @to ${mineRx}
     GROUP BY CAST(r.created_at AS date) ORDER BY d`, p)).recordset;
  const req = (await mssql(
    `SELECT CAST(created_at AS date) AS d, COUNT(*) AS n
     FROM dbo.tp_cypress_requests
     WHERE CAST(created_at AS date) BETWEEN @from AND @to
     GROUP BY CAST(created_at AS date) ORDER BY d`, { from, to })).recordset;
  return ok({ from, to, rx_received: rx, cypress_requests: req, cypress: CYPRESS });
}
