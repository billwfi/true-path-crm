const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
  const { role } = event.queryStringParameters || {};
  try {
    const r = await mssql(
      `SELECT id, firstname, lastname, email, role FROM dbo.Users
       WHERE active = 1 AND (@role IS NULL OR role = @role)
       ORDER BY firstname, lastname`,
      { role: role || null }
    );
    return ok(r.recordset);
  } catch (err) {
    return serverError(err);
  }
};
