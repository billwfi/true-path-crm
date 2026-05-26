const { db } = require('./_db');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  const { id, staff_id, rel_type, rel_id, upcoming } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await db(
          `SELECT r.*, COALESCE(s.firstname,'')||' '||COALESCE(s.lastname,'') AS staff_name,
                  COALESCE(c.firstname,'')||' '||COALESCE(c.lastname,'') AS created_by_name
           FROM tp_reminders r
           LEFT JOIN tp_staff s ON s.id = r.staff_id
           LEFT JOIN tp_staff c ON c.id = r.created_by
           WHERE r.id = $1`, [id]);
        return r.rows[0] ? ok(r.rows[0]) : notFound();
      }

      // List with optional filters
      const conditions = [];
      const params = [];

      if (staff_id) { conditions.push(`r.staff_id = $${params.length+1}`); params.push(parseInt(staff_id)); }
      if (rel_type)  { conditions.push(`r.rel_type = $${params.length+1}`); params.push(rel_type); }
      if (rel_id)    { conditions.push(`r.rel_id = $${params.length+1}`); params.push(parseInt(rel_id)); }
      if (upcoming === 'true') {
        conditions.push(`r.reminder_date >= NOW()`);
        conditions.push(`r.is_closed = false`);
      }

      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      const r = await db(
        `SELECT r.id, r.rel_type, r.rel_id, r.description, r.reminder_date,
                r.notify_by_email, r.is_closed, r.created_at,
                r.staff_id, COALESCE(s.firstname,'')||' '||COALESCE(s.lastname,'') AS staff_name,
                r.created_by, COALESCE(c.firstname,'')||' '||COALESCE(c.lastname,'') AS created_by_name
         FROM tp_reminders r
         LEFT JOIN tp_staff s ON s.id = r.staff_id
         LEFT JOIN tp_staff c ON c.id = r.created_by
         ${where}
         ORDER BY r.reminder_date ASC, r.created_at DESC`,
        params);
      return ok(r.rows);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      if (!b.description || !b.reminder_date) return badRequest('description and reminder_date required');
      const r = await db(
        `INSERT INTO tp_reminders (rel_type, rel_id, staff_id, created_by, description, reminder_date, notify_by_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [b.rel_type||null, b.rel_id||null, b.staff_id||user.id,
         user.id, b.description, b.reminder_date, b.notify_by_email||false]);
      return created({ id: r.rows[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await db(
        `UPDATE tp_reminders SET description=$1, reminder_date=$2, staff_id=$3,
         notify_by_email=$4, is_closed=$5 WHERE id=$6`,
        [b.description, b.reminder_date, b.staff_id||null,
         b.notify_by_email||false, b.is_closed||false, id]);
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await db('DELETE FROM tp_reminders WHERE id = $1', [id]);
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
