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
          `SELECT l.*, COALESCE(s.firstname,'')||' '||COALESCE(s.lastname,'') AS assigned_name
           FROM tp_leads l LEFT JOIN tp_staff s ON s.id = l.assigned_id WHERE l.id = $1`, [id]);
        return r.rows[0] ? ok(r.rows[0]) : notFound();
      }
      const r = await db(
        `SELECT l.id,l.name,l.company,l.email,l.phone,l.value,l.status,l.source,l.last_contact,l.tags,l.created_at,
         COALESCE(s.firstname,'')||' '||COALESCE(s.lastname,'') AS assigned_name
         FROM tp_leads l LEFT JOIN tp_staff s ON s.id = l.assigned_id
         WHERE ($1::text IS NULL OR l.status = $1)
         AND ($2::text IS NULL OR l.name ILIKE $2 OR l.company ILIKE $2 OR l.email ILIKE $2)
         ORDER BY l.created_at DESC`,
        [status || null, search ? `%${search}%` : null]);
      return ok(r.rows);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await db(
        `INSERT INTO tp_leads (name,company,email,phone,value,assigned_id,status,source,tags,notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [b.name||'', b.company||null, b.email||null, b.phone||null, b.value||null,
         b.assigned_id||null, b.status||'New', b.source||null, b.tags||null, b.notes||null]);
      return created({ id: r.rows[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await db(
        `UPDATE tp_leads SET name=$1,company=$2,email=$3,phone=$4,value=$5,assigned_id=$6,
         status=$7,source=$8,last_contact=$9,tags=$10,notes=$11 WHERE id=$12`,
        [b.name, b.company||null, b.email||null, b.phone||null, b.value||null,
         b.assigned_id||null, b.status, b.source||null, b.last_contact||null,
         b.tags||null, b.notes||null, id]);
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await db('DELETE FROM tp_leads WHERE id = $1', [id]);
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
