const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('./_db');
const { ok, badRequest, unauthorized, serverError, options, CORS, SECRET } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();

  if (event.httpMethod === 'POST') {
    try {
      const { email, password } = JSON.parse(event.body || '{}');
      if (!email || !password) return badRequest('Email and password required');

      // Env-var fallback admin (works before DB schema is set up)
      if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
        const adminUser = { id: 0, email, firstname: 'Admin', lastname: '', is_admin: true, role: 'Admin' };
        const token = jwt.sign(adminUser, SECRET, { expiresIn: '8h' });
        return ok({ token, user: adminUser });
      }

      const r = await db('SELECT id, email, firstname, lastname, is_admin, role, password_hash FROM tp_staff WHERE email = $1 AND active = true', [email]);
      const user = r.rows[0];
      if (!user) return unauthorized();

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return unauthorized();

      const payload = { id: user.id, email: user.email, firstname: user.firstname, lastname: user.lastname, is_admin: user.is_admin, role: user.role || 'Staff' };
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
