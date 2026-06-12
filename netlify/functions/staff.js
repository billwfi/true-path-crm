const { db } = require('./_db');
const { verifyToken, unauthorized, ok, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
  const { role } = event.queryStringParameters || {};
  try {
    const r = await db(
      `SELECT id, firstname, lastname, email, role FROM tp_staff
       WHERE active = true AND ($1::text IS NULL OR role = $1)
       ORDER BY firstname, lastname`,
      [role || null]
    );
    return ok(r.rows);
  } catch (err) {
    return serverError(err);
  }
};
