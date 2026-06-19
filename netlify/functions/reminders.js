const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  const { id, staff_id, rel_type, rel_id, upcoming } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await mssql(
          `SELECT r.*, CONCAT(s.firstname, ' ', s.lastname) AS staff_name,
                  CONCAT(c.firstname, ' ', c.lastname) AS created_by_name
           FROM tp_reminders r
           LEFT JOIN tp_staff s ON s.id = r.staff_id
           LEFT JOIN tp_staff c ON c.id = r.created_by
           WHERE r.id = @id`, { id: parseInt(id, 10) });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }

      // List with optional filters
      const conditions = [];
      const params = {};
      if (staff_id) { conditions.push('r.staff_id = @staff_id'); params.staff_id = parseInt(staff_id, 10); }
      if (rel_type) { conditions.push('r.rel_type = @rel_type'); params.rel_type = rel_type; }
      if (rel_id)   { conditions.push('r.rel_id = @rel_id'); params.rel_id = parseInt(rel_id, 10); }
      if (upcoming === 'true') {
        conditions.push('r.reminder_date >= SYSUTCDATETIME()');
        conditions.push('r.is_closed = 0');
      }
      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const r = await mssql(
        `SELECT r.id, r.rel_type, r.rel_id, r.description, r.reminder_date,
                r.notify_by_email, r.is_closed, r.created_at,
                r.staff_id, CONCAT(s.firstname, ' ', s.lastname) AS staff_name,
                r.created_by, CONCAT(c.firstname, ' ', c.lastname) AS created_by_name
         FROM tp_reminders r
         LEFT JOIN tp_staff s ON s.id = r.staff_id
         LEFT JOIN tp_staff c ON c.id = r.created_by
         ${where}
         ORDER BY r.reminder_date ASC, r.created_at DESC`,
        params);
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      if (!b.description || !b.reminder_date) return badRequest('description and reminder_date required');
      const r = await mssql(
        `INSERT INTO tp_reminders (rel_type, rel_id, staff_id, created_by, description, reminder_date, notify_by_email)
         VALUES (@rel_type,@rel_id,@staff_id,@created_by,@description,@reminder_date,@notify_by_email);
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
        { rel_type: b.rel_type || null, rel_id: b.rel_id || null, staff_id: b.staff_id || user.id,
          created_by: user.id, description: b.description, reminder_date: b.reminder_date,
          notify_by_email: b.notify_by_email ? 1 : 0 });
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await mssql(
        `UPDATE tp_reminders SET description=@description, reminder_date=@reminder_date, staff_id=@staff_id,
         notify_by_email=@notify_by_email, is_closed=@is_closed WHERE id=@id`,
        { description: b.description, reminder_date: b.reminder_date, staff_id: b.staff_id || null,
          notify_by_email: b.notify_by_email ? 1 : 0, is_closed: b.is_closed ? 1 : 0, id: parseInt(id, 10) });
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await mssql('DELETE FROM tp_reminders WHERE id = @id', { id: parseInt(id, 10) });
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
