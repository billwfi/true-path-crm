const { db } = require('./_db');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id, status, search } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await db(
          `SELECT t.*, COALESCE(s.firstname,'')||' '||COALESCE(s.lastname,'') AS assigned_name
           FROM tp_tasks t LEFT JOIN tp_staff s ON s.id = t.assigned_id WHERE t.id = $1`, [id]);
        return r.rows[0] ? ok(r.rows[0]) : notFound();
      }
      const r = await db(
        `SELECT t.id,t.name,t.status,t.priority,t.start_date,t.due_date,t.tags,t.color,t.related_type,t.related_id,t.created_at,
         COALESCE(s.firstname,'')||' '||COALESCE(s.lastname,'') AS assigned_name
         FROM tp_tasks t LEFT JOIN tp_staff s ON s.id = t.assigned_id
         WHERE ($1::text IS NULL OR t.status = $1)
         AND ($2::text IS NULL OR t.name ILIKE $2)
         ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC`,
        [status || null, search ? `%${search}%` : null]);
      return ok(r.rows);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await db(
        `INSERT INTO tp_tasks (name,status,priority,start_date,due_date,assigned_id,tags,color,related_type,related_id,description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [b.name||'', b.status||'Not Started', b.priority||'Medium', b.start_date||null,
         b.due_date||null, b.assigned_id||null, b.tags||null, b.color||null,
         b.related_type||null, b.related_id||null, b.description||null]);
      return created({ id: r.rows[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await db(
        `UPDATE tp_tasks SET name=$1,status=$2,priority=$3,start_date=$4,due_date=$5,
         assigned_id=$6,tags=$7,color=$8,description=$9 WHERE id=$10`,
        [b.name, b.status, b.priority, b.start_date||null, b.due_date||null,
         b.assigned_id||null, b.tags||null, b.color||null, b.description||null, id]);
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await db('DELETE FROM tp_tasks WHERE id = $1', [id]);
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
