const { db } = require('./_db');
const { verifyToken, unauthorized, ok, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
  try {
    const r = await db(
      `SELECT id, firstname, lastname, email FROM tp_staff WHERE active = true ORDER BY firstname, lastname`
    );
    return ok(r.rows);
  } catch (err) {
    return serverError(err);
  }
};
