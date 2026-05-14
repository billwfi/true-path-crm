const { db } = require('./_db');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id, search } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await db('SELECT * FROM tp_companies WHERE id = $1', [id]);
        return r.rows[0] ? ok(r.rows[0]) : notFound();
      }
      const r = await db(
        'SELECT * FROM tp_companies WHERE ($1::text IS NULL OR name ILIKE $1 OR city ILIKE $1 OR state ILIKE $1) ORDER BY name',
        [search ? `%${search}%` : null]);
      return ok(r.rows);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await db(
        'INSERT INTO tp_companies (name,phone,address,city,state,zip_code) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [b.name||'', b.phone||null, b.address||null, b.city||null, b.state||null, b.zip_code||null]);
      return created({ id: r.rows[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await db(
        'UPDATE tp_companies SET name=$1,phone=$2,address=$3,city=$4,state=$5,zip_code=$6 WHERE id=$7',
        [b.name, b.phone||null, b.address||null, b.city||null, b.state||null, b.zip_code||null, id]);
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await db('DELETE FROM tp_companies WHERE id = $1', [id]);
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
