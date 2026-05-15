const { db } = require('./_db');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id, search } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await db(
          `SELECT c.*, co.name AS company, co.id AS company_id, b.name AS broker, b.id AS broker_id,
           COALESCE(s.firstname,'') || ' ' || COALESCE(s.lastname,'') AS coordinator
           FROM tp_clients c
           LEFT JOIN tp_companies co ON co.id = c.company_id
           LEFT JOIN tp_brokers b ON b.id = c.broker_id
           LEFT JOIN tp_staff s ON s.id = c.account_coordinator
           WHERE c.id = $1`, [id]);
        return r.rows[0] ? ok(r.rows[0]) : notFound();
      }
      const r = await db(
        `SELECT c.id, c.firstname, c.lastname, c.email, c.phone, c.active, c.groups, c.created_at,
         co.name AS company, co.id AS company_id, b.name AS broker, b.id AS broker_id,
         COALESCE(s.firstname,'') || ' ' || COALESCE(s.lastname,'') AS coordinator
         FROM tp_clients c
         LEFT JOIN tp_companies co ON co.id = c.company_id
         LEFT JOIN tp_brokers b ON b.id = c.broker_id
         LEFT JOIN tp_staff s ON s.id = c.account_coordinator
         WHERE ($1::text IS NULL OR c.firstname || ' ' || c.lastname ILIKE $1 OR c.email ILIKE $1 OR co.name ILIKE $1)
         ORDER BY c.created_at DESC`,
        [search ? `%${search}%` : null]);
      return ok(r.rows);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await db(
        `INSERT INTO tp_clients (firstname, lastname, email, phone, company_id, broker_id, account_coordinator, groups, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [b.firstname||'', b.lastname||'', b.email||null, b.phone||null,
         parseInt(b.company_id)||null, parseInt(b.broker_id)||null, parseInt(b.account_coordinator)||null, b.groups||null, b.notes||null]);
      return created({ id: r.rows[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await db(
        `UPDATE tp_clients SET firstname=$1, lastname=$2, email=$3, phone=$4, active=$5,
         company_id=$6, broker_id=$7, account_coordinator=$8, groups=$9, notes=$10 WHERE id=$11`,
        [b.firstname, b.lastname, b.email||null, b.phone||null, b.active !== false && b.active !== 0,
         parseInt(b.company_id)||null, parseInt(b.broker_id)||null, parseInt(b.account_coordinator)||null, b.groups||null, b.notes||null, id]);
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await db('DELETE FROM tp_clients WHERE id = $1', [id]);
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
