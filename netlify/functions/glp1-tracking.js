const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options, CORS } = require('./_auth');

// Contact tracking + intake status for an assigned GLP1 member.
// member = member_key (Member_ID, or idx:<indx> fallback for null-member records).

const CONTACT_TYPES = ['Phone Call', 'Text', 'Email', 'Other'];
const CONTACT_STATUSES = ['Open', 'Closed'];
const INTAKE_STATUSES = ['In Progress', 'Outreach Completed', 'Submitted to WellSync'];
const SUB_STATUSES = ['Declined Enrollment', 'Approved', 'Clinical Denial'];

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  const { member, contact_id, action, category, resource } = event.queryStringParameters || {};
  const cat = category || 'GLP1';

  try {
    if (event.httpMethod === 'GET') {
      if (!member) return badRequest('member is required');
      if (resource === 'intakes') {
        // All intake records this member holds — one per intake_type (GLP1, non-GLP1, …),
        // each with its type label/color, the questionnaire flag, and the concierge the
        // member is assigned to for that track (from the latest matching ReadyToAssign row).
        const rows = (await mssql(
          `SELECT mi.intake_type, mi.status, mi.sub_status, mi.status_date, mi.updated_at,
                  t.name, t.color, t.is_glp1,
                  asg.assigned_to, LTRIM(RTRIM(CONCAT(u.firstname,' ',u.lastname))) AS assigned_name
           FROM dbo.tp_member_intakes mi
           LEFT JOIN dbo.tp_intake_types t ON t.code = mi.intake_type
           OUTER APPLY (SELECT TOP 1 r.assigned_to FROM dbo.ReadyToAssign r
             WHERE r.category = mi.intake_type
               AND COALESCE(NULLIF(r.Member_ID,''), CAST(r.indx AS VARCHAR(50))) = mi.member_key
               AND r.assigned_to IS NOT NULL
             ORDER BY r.assigned_at DESC) asg
           LEFT JOIN dbo.Users u ON u.id = asg.assigned_to
           WHERE mi.member_key = @member
           ORDER BY t.sort_order, mi.intake_type`, { member })).recordset;
        return ok(rows);
      }
      const contacts = await mssql(
        `SELECT id, member_key, contact_date, contact_type, notes, followup_date,
                contact_status, created_by, created_at
         FROM dbo.GLP1_ContactLog WHERE category = @category AND member_key = @member
         ORDER BY contact_date DESC, id DESC`,
        { category: cat, member });
      // Unified Intake Status record (one per member + intake_type). The questionnaire
      // is folded in as part of this record.
      const row = (await mssql(
        `SELECT member_key, status, status_date, sub_status, questionnaire, disqualified, updated_by, updated_at
         FROM dbo.tp_member_intakes WHERE intake_type = @category AND member_key = @member`,
        { category: cat, member })).recordset[0] || null;
      return ok({
        contacts: contacts.recordset,
        attempts: contacts.recordset.length,
        intake: row ? {
          member_key: row.member_key, status: row.status, status_date: row.status_date,
          sub_status: row.sub_status, updated_by: row.updated_by, updated_at: row.updated_at,
        } : null,
        questionnaire: (row && row.questionnaire != null) ? {
          answers: safeParse(row.questionnaire),
          disqualified: !!row.disqualified,
          updated_at: row.updated_at,
        } : null,
      });
    }

    if (event.httpMethod === 'POST') {
      // Add a contact attempt.
      if (!member) return badRequest('member is required');
      const b = JSON.parse(event.body || '{}');
      const type = CONTACT_TYPES.includes(b.contact_type) ? b.contact_type : null;
      if (!type) return badRequest('contact_type must be one of: ' + CONTACT_TYPES.join(', '));
      const status = CONTACT_STATUSES.includes(b.contact_status) ? b.contact_status : 'Open';
      const r = await mssql(
        `INSERT INTO dbo.GLP1_ContactLog
           (member_key, category, contact_date, contact_type, notes, followup_date, contact_status, created_by)
         OUTPUT INSERTED.*
         VALUES (@member, @category, @contact_date, @contact_type, @notes, @followup_date, @contact_status, @created_by)`,
        {
          member, category: cat,
          contact_date: b.contact_date || new Date().toISOString().slice(0, 10),
          contact_type: type, notes: b.notes || null,
          followup_date: b.followup_date || null, contact_status: status,
          created_by: user.id || null,
        });
      return created(r.recordset[0]);
    }

    if (event.httpMethod === 'PATCH') {
      if (action === 'add-intake') {
        // Start a new intake track for this member (one per intake_type). No-op if it
        // already exists, so the button is idempotent.
        if (!member) return badRequest('member is required');
        const t = (await mssql('SELECT code FROM dbo.tp_intake_types WHERE code=@c AND active=1', { c: cat })).recordset[0];
        if (!t) return badRequest('unknown intake_type');
        const r = await mssql(
          `SET NOCOUNT ON;
           IF NOT EXISTS (SELECT 1 FROM dbo.tp_member_intakes WHERE member_key=@member AND intake_type=@category)
             INSERT INTO dbo.tp_member_intakes (member_key, intake_type, status, status_date, updated_by)
             VALUES (@member, @category, 'In Progress', CAST(GETDATE() AS DATE), @by);
           SELECT @@ROWCOUNT AS added;`,
          { member, category: cat, by: user.id || null });
        return ok({ ok: true, intake_type: cat, added: (r.recordset[0] || {}).added || 0 });
      }

      if (action === 'questionnaire') {
        // Upsert the member's intake questionnaire (answers stored as JSON).
        if (!member) return badRequest('member is required');
        const b = JSON.parse(event.body || '{}');
        const answers = JSON.stringify(b.answers || {});
        const dq = b.disqualified ? 1 : 0;
        const r = await mssql(
          `MERGE dbo.tp_member_intakes AS t
           USING (SELECT @member AS member_key, @category AS intake_type) AS s
           ON t.member_key = s.member_key AND t.intake_type = s.intake_type
           WHEN MATCHED THEN UPDATE SET questionnaire=@answers, disqualified=@dq,
             updated_by=@updated_by, updated_at=GETDATE()
           WHEN NOT MATCHED THEN INSERT (member_key, intake_type, status, status_date, questionnaire, disqualified, updated_by)
             VALUES (@member, @category, 'In Progress', CAST(GETDATE() AS DATE), @answers, @dq, @updated_by)
           OUTPUT INSERTED.disqualified, INSERTED.updated_at;`,
          { member, category: cat, answers, dq, updated_by: user.id || null });
        return ok({ ok: true, disqualified: !!(r.recordset[0] || {}).disqualified,
                    updated_at: (r.recordset[0] || {}).updated_at });
      }

      if (action === 'intake') {
        // Upsert the member's intake status record (one per member + intake_type).
        if (!member) return badRequest('member is required');
        const b = JSON.parse(event.body || '{}');
        // Type-driven lifecycle: allowed statuses / sub-statuses come from the intake-type
        // taxonomy, falling back to the GLP1 defaults for older data.
        let allowedStatuses = INTAKE_STATUSES;
        let subMap = { 'Submitted to WellSync': SUB_STATUSES };
        const tcfg = (await mssql('SELECT statuses, sub_statuses FROM dbo.tp_intake_types WHERE code=@c', { c: cat })).recordset[0];
        if (tcfg) {
          const s = safeParse(tcfg.statuses); if (Array.isArray(s) && s.length) allowedStatuses = s;
          const sm = safeParse(tcfg.sub_statuses); if (sm && typeof sm === 'object') subMap = sm;
        }
        const status = allowedStatuses.includes(b.status) ? b.status : allowedStatuses[0];
        const subsForStatus = Array.isArray(subMap[status]) ? subMap[status] : [];
        const sub = subsForStatus.includes(b.sub_status) ? b.sub_status : null;
        const r = await mssql(
          `MERGE dbo.tp_member_intakes AS t
           USING (SELECT @member AS member_key, @category AS intake_type) AS s
           ON t.member_key = s.member_key AND t.intake_type = s.intake_type
           WHEN MATCHED THEN UPDATE SET status=@status, status_date=@status_date,
             sub_status=@sub_status, updated_by=@updated_by, updated_at=GETDATE()
           WHEN NOT MATCHED THEN INSERT (member_key, intake_type, status, status_date, sub_status, updated_by)
             VALUES (@member, @category, @status, @status_date, @sub_status, @updated_by)
           OUTPUT INSERTED.member_key, INSERTED.status, INSERTED.status_date,
                  INSERTED.sub_status, INSERTED.updated_by, INSERTED.updated_at;`,
          {
            member, category: cat, status,
            status_date: b.status_date || new Date().toISOString().slice(0, 10),
            sub_status: sub, updated_by: user.id || null,
          });
        return ok(r.recordset[0]);
      }

      // Update a single contact attempt (e.g. close it / edit notes).
      const cid = parseInt(contact_id, 10);
      if (!cid) return badRequest('contact_id is required');
      const b = JSON.parse(event.body || '{}');
      const sets = [];
      const params = { id: cid };
      if ('contact_date' in b) { sets.push('contact_date=@contact_date'); params.contact_date = b.contact_date; }
      if ('contact_type' in b) {
        if (!CONTACT_TYPES.includes(b.contact_type)) return badRequest('invalid contact_type');
        sets.push('contact_type=@contact_type'); params.contact_type = b.contact_type;
      }
      if ('notes' in b) { sets.push('notes=@notes'); params.notes = b.notes || null; }
      if ('followup_date' in b) { sets.push('followup_date=@followup_date'); params.followup_date = b.followup_date || null; }
      if ('contact_status' in b) {
        if (!CONTACT_STATUSES.includes(b.contact_status)) return badRequest('invalid contact_status');
        sets.push('contact_status=@contact_status'); params.contact_status = b.contact_status;
      }
      if (!sets.length) return badRequest('No updatable fields provided');
      const r = await mssql(
        `UPDATE dbo.GLP1_ContactLog SET ${sets.join(', ')} OUTPUT INSERTED.* WHERE id=@id`, params);
      return r.recordset[0] ? ok(r.recordset[0]) : notFound();
    }

    if (event.httpMethod === 'DELETE') {
      if (action === 'delete-intake') {
        // Remove an entire intake track for this member: its status/questionnaire record
        // plus its contact log. Leaves any assignment (ReadyToAssign) untouched.
        if (!member) return badRequest('member is required');
        await mssql('DELETE FROM dbo.GLP1_ContactLog WHERE member_key=@member AND category=@category',
          { member, category: cat });
        const r = await mssql('DELETE FROM dbo.tp_member_intakes WHERE member_key=@member AND intake_type=@category',
          { member, category: cat });
        return ok({ deleted: r.rowsAffected[0] || 0 });
      }
      const cid = parseInt(contact_id, 10);
      if (!cid) return badRequest('contact_id is required');
      const r = await mssql('DELETE FROM dbo.GLP1_ContactLog WHERE id=@id', { id: cid });
      return r.rowsAffected[0] ? ok({ deleted: true }) : notFound();
    }

    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};

function safeParse(json) {
  if (!json) return {};
  try { return JSON.parse(json); } catch { return {}; }
}
