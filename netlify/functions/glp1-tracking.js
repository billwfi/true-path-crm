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

  const { member, contact_id, action, category } = event.queryStringParameters || {};
  const cat = category || 'GLP1';

  try {
    if (event.httpMethod === 'GET') {
      if (!member) return badRequest('member is required');
      const contacts = await mssql(
        `SELECT id, member_key, contact_date, contact_type, notes, followup_date,
                contact_status, created_by, created_at
         FROM dbo.GLP1_ContactLog WHERE category = @category AND member_key = @member
         ORDER BY contact_date DESC, id DESC`,
        { category: cat, member });
      const intake = await mssql(
        `SELECT member_key, status, status_date, sub_status, updated_by, updated_at
         FROM dbo.GLP1_Intake WHERE category = @category AND member_key = @member`,
        { category: cat, member });
      return ok({
        contacts: contacts.recordset,
        attempts: contacts.recordset.length,
        intake: intake.recordset[0] || null,
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
      if (action === 'intake') {
        // Upsert the member's intake record.
        if (!member) return badRequest('member is required');
        const b = JSON.parse(event.body || '{}');
        const status = INTAKE_STATUSES.includes(b.status) ? b.status : 'In Progress';
        // Sub-status only valid when submitted to WellSync.
        const sub = status === 'Submitted to WellSync'
          ? (SUB_STATUSES.includes(b.sub_status) ? b.sub_status : null)
          : null;
        const r = await mssql(
          `MERGE dbo.GLP1_Intake AS t
           USING (SELECT @member AS member_key, @category AS category) AS s
           ON t.member_key = s.member_key AND t.category = s.category
           WHEN MATCHED THEN UPDATE SET status=@status, status_date=@status_date,
             sub_status=@sub_status, updated_by=@updated_by, updated_at=GETDATE()
           WHEN NOT MATCHED THEN INSERT (member_key, category, status, status_date, sub_status, updated_by)
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
