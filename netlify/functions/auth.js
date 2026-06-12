const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { mssql } = require('./_mssql');
const { ok, badRequest, unauthorized, serverError, options, CORS, SECRET } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();

  if (event.httpMethod === 'POST') {
    try {
      const { email, password } = JSON.parse(event.body || '{}');
      if (!email || !password) return badRequest('Email and password required');

      // Env-var fallback admin (bootstrap — works even if dbo.Users is unreachable)
      if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
        const adminUser = { id: 0, email, firstname: 'Admin', lastname: '', is_admin: true, user_type: 'Admin', role: 'Admin', nav_access: null };
        const token = jwt.sign(adminUser, SECRET, { expiresIn: '8h' });
        return ok({ token, user: adminUser });
      }

      // Users now live in SQL Server (dbo.Users) — see scripts/seed-users.js.
      const r = await mssql(
        `SELECT id, email, firstname, lastname, user_type, role, nav_access, password_hash
         FROM dbo.Users WHERE email = @email AND active = 1`,
        { email });
      const user = r.recordset[0];
      if (!user) return unauthorized();

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return unauthorized();

      const payload = {
        id: user.id, email: user.email, firstname: user.firstname, lastname: user.lastname,
        is_admin: user.user_type === 'Admin', user_type: user.user_type || 'User',
        role: user.role || 'Staff', nav_access: user.nav_access || null,
      };
      const token = jwt.sign(payload, SECRET, { expiresIn: '8h' });
      return ok({ token, user: payload });
    } catch (err) {
      return serverError(err);
    }
  }

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
