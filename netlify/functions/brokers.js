const { db } = require('./_db');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id, search } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await db('SELECT * FROM tp_brokers WHERE id = $1', [id]);
        return r.rows[0] ? ok(r.rows[0]) : notFound();
      }
      const r = await db(
        'SELECT * FROM tp_brokers WHERE ($1::text IS NULL OR name ILIKE $1 OR email ILIKE $1) ORDER BY name',
        [search ? `%${search}%` : null]);
      return ok(r.rows);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await db(
        'INSERT INTO tp_brokers (name,status,address,email,phone) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [b.name||'', b.status||'Active', b.address||null, b.email||null, b.phone||null]);
      return created({ id: r.rows[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await db(
        'UPDATE tp_brokers SET name=$1,status=$2,address=$3,email=$4,phone=$5 WHERE id=$6',
        [b.name, b.status||'Active', b.address||null, b.email||null, b.phone||null, id]);
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await db('DELETE FROM tp_brokers WHERE id = $1', [id]);
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
