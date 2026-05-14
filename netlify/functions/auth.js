const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getPool, sql } = require('./_db');
const { ok, badRequest, unauthorized, serverError, options, CORS, SECRET } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();

  // POST /auth — login
  if (event.httpMethod === 'POST') {
    try {
      const { email, password } = JSON.parse(event.body || '{}');
      if (!email || !password) return badRequest('Email and password required');

      // Env-var fallback admin (useful before DB is set up)
      if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
        const token = jwt.sign({ id: 0, email, firstname: 'Admin', lastname: '', is_admin: true }, SECRET, { expiresIn: '8h' });
        return ok({ token, user: { id: 0, email, firstname: 'Admin', lastname: '', is_admin: true } });
      }

      const pool = await getPool();
      const result = await pool.request()
        .input('email', sql.NVarChar, email)
        .query('SELECT id, email, firstname, lastname, is_admin, password_hash FROM tp_staff WHERE email = @email AND active = 1');

      const user = result.recordset[0];
      if (!user) return unauthorized();

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return unauthorized();

      const token = jwt.sign(
        { id: user.id, email: user.email, firstname: user.firstname, lastname: user.lastname, is_admin: !!user.is_admin },
        SECRET,
        { expiresIn: '8h' }
      );

      return ok({ token, user: { id: user.id, email: user.email, firstname: user.firstname, lastname: user.lastname, is_admin: !!user.is_admin } });
    } catch (err) {
      return serverError(err);
    }
  }

  // GET /auth — verify token / get current user
  if (event.httpMethod === 'GET') {
    const auth = (event.headers.authorization || event.headers.Authorization || '').trim();
    if (!auth.startsWith('Bearer ')) return unauthorized();
    try {
      const payload = jwt.verify(auth.slice(7), SECRET);
      return ok({ user: payload });
    } catch {
      return unauthorized();
    }
  }

  return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
};
