const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');
const { nextFollowup } = require('./_cadence');

// CC Phase 3 increment 2 — Rx file processing (RXF2 + CC4 batch intake + CS4).
// Structured Rx records (metadata + link, no binary hosting): naming taxonomy,
// Files-tab label, day supply, name/DOB confirmation, dosage-change flag.
//   GET  /rx-records?order_id=            -> records for an order
//   GET  /rx-records?member=&category=    -> records for a member+intake
//   GET  /rx-records?resource=list[&...]  -> daily Rx-processing list across members
//   GET  /rx-records?resource=reply&order_id=  -> composed "Rx received for" reply
//   POST /rx-records?order_id=&member=&category=  -> add a record
//   PATCH /rx-records?id=                 -> update a record
//   DELETE /rx-records?id=

const STATUSES = ['Valid', 'INVALID', 'CANNOT SOURCE', 'DUPLICATE RX', 'DENIED RX', 'NEED 90 DAY', 'CANCELLED RX', 'NEEDS CLARIFICATION'];
const DAY_SUPPLY_STATUSES = ['Valid', 'NEED 90 DAY'];      // day supply appended to these only
const BAD_CHARS = /[#<>/]/;                                  // disallowed in file names/labels

function fmtWR(d) {
  if (!d) return '';
  const s = String(d).slice(0, 10).split('-');
  return s.length === 3 ? `${+s[1]}/${+s[2]}/${s[0]}` : String(d);
}

// Naming taxonomy: "Member Name (DOB) - Medication Strength - WR Date" + status suffix.
function buildFileName(r) {
  const base = `${r.member_name || ''} (${r.dob || ''}) - ${[r.medication, r.strength].filter(Boolean).join(' ')} - WR ${fmtWR(r.written_date)}`;
  let suffix = '';
  switch (r.status) {
    case 'INVALID': suffix = ` - INVALID${r.invalid_reason ? ` (${r.invalid_reason})` : ''}`; break;
    case 'CANNOT SOURCE': suffix = ' - CANNOT SOURCE'; break;
    case 'DUPLICATE RX': suffix = ' - DUPLICATE RX'; break;
    case 'DENIED RX': suffix = ' - DENIED RX'; break;
    case 'NEED 90 DAY': suffix = ' - NEED 90 DAY'; break;
    case 'CANCELLED RX': suffix = ` - CANCELLED RX${r.original_wr_date ? ` (orig WR ${fmtWR(r.original_wr_date)})` : ''}`; break;
    case 'NEEDS CLARIFICATION': suffix = ' - NEEDS CLARIFICATION'; break;
    default: suffix = '';
  }
  return (base + suffix).replace(/\s+/g, ' ').trim();
}

// Files-tab label per SOP Step 4.
function buildLabel(r) {
  const ds = r.day_supply != null && r.day_supply !== '' ? `${r.day_supply} day` : '';
  switch (r.status) {
    case 'Valid': return `Rx${ds ? ` - ${ds}` : ''}`;
    case 'NEED 90 DAY': return `NEED 90 DAY${ds ? ` - ${ds}` : ''}`;
    case 'INVALID': return `INVALID${r.invalid_reason ? ` - ${r.invalid_reason}` : ''}`;
    case 'CANNOT SOURCE': return 'CANNOT SOURCE';
    case 'DUPLICATE RX': return 'DUPLICATE';
    case 'DENIED RX': return 'DENIED RX';
    case 'CANCELLED RX': return `CANCELLED RX${r.original_wr_date ? ` - Original WR ${fmtWR(r.original_wr_date)}` : ''}`;
    case 'NEEDS CLARIFICATION': return 'NEEDS CLARIFICATION';
    default: return 'Rx';
  }
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  const q = event.queryStringParameters || {};
  const cat = q.category || 'GLP1';

  try {
    if (event.httpMethod === 'GET') {
      if (q.resource === 'reply') return composeReply(q);
      if (q.resource === 'list') return listProcessing(q, user);
      let where = '', params = {};
      if (q.order_id) { where = 'order_id = @oid'; params.oid = parseInt(q.order_id, 10); }
      else if (q.member) { where = 'member_key = @m AND intake_type = @c'; params = { m: q.member, c: cat }; }
      else return badRequest('order_id or member required');
      const rows = (await mssql(
        `SELECT * FROM dbo.tp_rx_records WHERE ${where} ORDER BY created_at DESC, id DESC`, params)).recordset;
      return ok({ records: rows });
    }

    if (event.httpMethod === 'POST') {
      if (!q.member) return badRequest('member is required');
      const b = JSON.parse(event.body || '{}');
      const status = STATUSES.includes(b.status) ? b.status : 'Valid';

      // SOP: name/DOB must be confirmed to match the profile before saving.
      if (!b.name_dob_confirmed) return badRequest('Confirm the member name and DOB match the profile first');

      const rec = {
        member_name: (b.member_name || '').trim(),
        dob: (b.dob || '').trim(),
        medication: (b.medication || '').trim(),
        strength: (b.strength || '').trim(),
        written_date: b.written_date || null,
        status,
        invalid_reason: status === 'INVALID' ? (b.invalid_reason || '').trim() : null,
        original_wr_date: status === 'CANCELLED RX' ? (b.original_wr_date || null) : null,
        day_supply: DAY_SUPPLY_STATUSES.includes(status) && b.day_supply !== '' && b.day_supply != null ? parseInt(b.day_supply, 10) : null,
        file_link: (b.file_link || '').trim() || null,
      };
      // Reject SharePoint/Windows-illegal characters in name-bearing fields.
      const checkFields = [rec.member_name, rec.medication, rec.strength, rec.invalid_reason].filter(Boolean);
      if (checkFields.some(v => BAD_CHARS.test(v)))
        return badRequest('File names/labels cannot contain # < > /');

      rec.file_name = buildFileName(rec);
      rec.label = buildLabel(rec);

      // Dosage-change detection vs the member's most recent prior Rx (RXF2).
      const last = (await mssql(
        `SELECT TOP 1 strength FROM dbo.tp_rx_records WHERE member_key=@m AND intake_type=@c ORDER BY created_at DESC, id DESC`,
        { m: q.member, c: cat })).recordset[0];
      const dosageChanged = !!(last && (last.strength || '') !== rec.strength);

      const r = await mssql(
        `INSERT INTO dbo.tp_rx_records
           (order_id, member_key, intake_type, member_name, dob, medication, strength, written_date,
            status, invalid_reason, original_wr_date, day_supply, file_name, label, file_link,
            name_dob_confirmed, dosage_changed, created_by, updated_at)
         OUTPUT INSERTED.*
         VALUES (@order_id, @m, @c, @member_name, @dob, @medication, @strength, @written_date,
            @status, @invalid_reason, @original_wr_date, @day_supply, @file_name, @label, @file_link,
            1, @dosage_changed, @by, SYSUTCDATETIME())`,
        { order_id: q.order_id ? parseInt(q.order_id, 10) : null, m: q.member, c: cat,
          ...rec, dosage_changed: dosageChanged ? 1 : 0, by: user.id || null });

      // On a dosage change, raise an LJ verification reminder before Verify Address.
      let ljReminder = false;
      if (dosageChanged) {
        const desc = `LJ VERIFY - ${rec.member_name || q.member} - strength change (${(last && last.strength) || '?'} -> ${rec.strength || '?'})`;
        const exists = (await mssql(
          `SELECT TOP 1 id FROM dbo.tp_reminders WHERE rel_type='Rx Dosage Verify' AND is_closed=0 AND description=@d`,
          { d: desc })).recordset[0];
        if (!exists) {
          await mssql(
            `INSERT INTO dbo.tp_reminders (rel_type, rel_id, staff_id, created_by, description, reminder_date, notify_by_email, is_closed)
             VALUES ('Rx Dosage Verify', NULL, NULL, @by, @d, @when, 0, 0)`,
            { by: user.id || null, d: desc, when: nextFollowup('High') + 'T09:00:00' });
          ljReminder = true;
        }
      }
      // Marking a valid Rx received advances the order.
      if (q.order_id && DAY_SUPPLY_STATUSES.includes(status) && b.mark_received) {
        await mssql(`UPDATE dbo.tp_orders SET getrx_status='Rx Received', stage='Rx Received', updated_at=SYSUTCDATETIME() WHERE id=@id`,
          { id: parseInt(q.order_id, 10) });
      }
      return created({ record: r.recordset[0], dosage_changed: dosageChanged, lj_reminder: ljReminder });
    }

    if (event.httpMethod === 'PATCH') {
      const id = parseInt(q.id, 10);
      if (!id) return badRequest('id required');
      const cur = (await mssql('SELECT * FROM dbo.tp_rx_records WHERE id=@id', { id })).recordset[0];
      if (!cur) return notFound();
      const b = JSON.parse(event.body || '{}');
      const merged = { ...cur };
      ['member_name', 'dob', 'medication', 'strength', 'invalid_reason', 'file_link'].forEach(k => { if (k in b) merged[k] = (b[k] || '').trim() || null; });
      if ('written_date' in b) merged.written_date = b.written_date || null;
      if ('original_wr_date' in b) merged.original_wr_date = b.original_wr_date || null;
      if ('status' in b && STATUSES.includes(b.status)) merged.status = b.status;
      if ('day_supply' in b) merged.day_supply = DAY_SUPPLY_STATUSES.includes(merged.status) && b.day_supply !== '' && b.day_supply != null ? parseInt(b.day_supply, 10) : null;
      const checkFields = [merged.member_name, merged.medication, merged.strength, merged.invalid_reason].filter(Boolean);
      if (checkFields.some(v => BAD_CHARS.test(v))) return badRequest('File names/labels cannot contain # < > /');
      merged.file_name = buildFileName(merged);
      merged.label = buildLabel(merged);
      await mssql(
        `UPDATE dbo.tp_rx_records SET member_name=@member_name, dob=@dob, medication=@medication, strength=@strength,
           written_date=@written_date, status=@status, invalid_reason=@invalid_reason, original_wr_date=@original_wr_date,
           day_supply=@day_supply, file_name=@file_name, label=@label, file_link=@file_link, updated_at=SYSUTCDATETIME()
         WHERE id=@id`,
        { id, member_name: merged.member_name, dob: merged.dob, medication: merged.medication, strength: merged.strength,
          written_date: merged.written_date, status: merged.status, invalid_reason: merged.invalid_reason,
          original_wr_date: merged.original_wr_date, day_supply: merged.day_supply,
          file_name: merged.file_name, label: merged.label, file_link: merged.file_link });
      return ok({ ok: true, file_name: merged.file_name, label: merged.label });
    }

    if (event.httpMethod === 'DELETE') {
      const id = parseInt(q.id, 10);
      if (!id) return badRequest('id required');
      const r = await mssql('DELETE FROM dbo.tp_rx_records WHERE id=@id', { id });
      return r.rowsAffected[0] ? ok({ deleted: true }) : notFound();
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};

// "Rx received for" reply — drug + WR + day supply as bullets, excluding name/DOB (SOP).
async function composeReply(q) {
  if (!q.order_id) return badRequest('order_id required');
  const rows = (await mssql(
    `SELECT medication, strength, written_date, day_supply, status FROM dbo.tp_rx_records
     WHERE order_id=@id AND status IN ('Valid','NEED 90 DAY') ORDER BY created_at`,
    { id: parseInt(q.order_id, 10) })).recordset;
  const bullets = rows.map(r =>
    `• ${[r.medication, r.strength].filter(Boolean).join(' ')} — WR ${fmtWR(r.written_date)}${r.day_supply ? ` — ${r.day_supply} day` : ''}`);
  const text = bullets.length ? `Rx received for:\n${bullets.join('\n')}` : 'No valid Rx recorded yet.';
  return ok({ reply: text, count: bullets.length });
}

// Daily Rx-processing list across members (CC4 rx-processing-notifi + CS4 rx-received-list).
async function listProcessing(q, user) {
  const conds = [], params = {};
  if (q.status) { conds.push('r.status = @status'); params.status = q.status; }
  if (q.from) { conds.push('CAST(r.created_at AS date) >= @from'); params.from = q.from; }
  if (q.to) { conds.push('CAST(r.created_at AS date) <= @to'); params.to = q.to; }
  if (q.mine === '1') { conds.push('o.assigned_to = @uid'); params.uid = user.id; }
  if (q.search) { conds.push('(r.member_name LIKE @s OR r.medication LIKE @s)'); params.s = `%${q.search}%`; }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const rows = (await mssql(
    `SELECT TOP 500 r.id, r.member_key, r.intake_type, r.member_name, r.medication, r.strength,
            r.written_date, r.status, r.day_supply, r.label, r.file_link, r.dosage_changed, r.created_at,
            o.id AS order_id, o.stage, o.getrx_status,
            LTRIM(RTRIM(CONCAT(u.firstname,' ',u.lastname))) AS assigned_name,
            asg.indx AS ready_indx
     FROM dbo.tp_rx_records r
     LEFT JOIN dbo.tp_orders o ON o.id = r.order_id
     LEFT JOIN dbo.Users u ON u.id = o.assigned_to
     OUTER APPLY (SELECT TOP 1 indx FROM dbo.ReadyToAssign ra
       WHERE ra.category = r.intake_type
         AND COALESCE(NULLIF(ra.Member_ID,''), CAST(ra.indx AS VARCHAR(50))) = r.member_key
       ORDER BY ra.indx DESC) asg
     ${where}
     ORDER BY r.created_at DESC, r.id DESC`, params)).recordset;
  return ok({ rows });
}
