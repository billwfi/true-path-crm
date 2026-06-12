const bcrypt = require('bcryptjs');
const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options, CORS } = require('./_auth');

// Only Admin-type users may manage users / set passwords.
function forbidden() {
  return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Admin access required' }) };
}
function isAdmin(user) {
  return !!user && (user.user_type === 'Admin' || user.is_admin === true);
}

const LIST_COLS = `id, email, firstname, lastname, user_type, role, nav_access, active, created_at`;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const me = verifyToken(event);
  if (!me) return unauthorized();
  if (!isAdmin(me)) return forbidden();

  const { id, action } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await mssql(`SELECT ${LIST_COLS} FROM dbo.Users WHERE id = @id`, { id: parseInt(id, 10) });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const r = await mssql(`SELECT ${LIST_COLS} FROM dbo.Users ORDER BY active DESC, firstname, lastname`);
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const email = (b.email || '').trim().toLowerCase();
      if (!email || !b.password) return badRequest('email and password are required');

      const dupe = await mssql('SELECT id FROM dbo.Users WHERE email = @email', { email });
      if (dupe.recordset.length) return badRequest('A user with that email already exists');

      const hash = await bcrypt.hash(b.password, 10);
      // dbo.Users.id is not an identity column (ids are preserved from tp_staff),
      // so allocate the next id explicitly.
      const r = await mssql(
        `DECLARE @newid INT = (SELECT ISNULL(MAX(id), 0) + 1 FROM dbo.Users);
         INSERT INTO dbo.Users (id, email, password_hash, firstname, lastname, user_type, role, nav_access, active)
         VALUES (@newid, @email, @password_hash, @firstname, @lastname, @user_type, @role, @nav_access, 1);
         SELECT ${LIST_COLS} FROM dbo.Users WHERE id = @newid;`,
        {
          email,
          password_hash: hash,
          firstname: b.firstname || null,
          lastname: b.lastname || null,
          user_type: b.user_type === 'Admin' ? 'Admin' : 'User',
          role: b.role || 'Staff',
          nav_access: b.nav_access || null,
        });
      return created(r.recordset[0]);
    }

    if (event.httpMethod === 'PATCH') {
      const uid = parseInt(id, 10);
      if (!uid) return badRequest('id is required');
      const b = JSON.parse(event.body || '{}');

      if (action === 'set-password') {
        if (!b.password) return badRequest('password is required');
        const hash = await bcrypt.hash(b.password, 10);
        const r = await mssql(
          `UPDATE dbo.Users SET password_hash = @password_hash WHERE id = @id`,
          { id: uid, password_hash: hash });
        return r.rowsAffected[0] ? ok({ updated: true }) : notFound();
      }

      // General profile / access update. Only apply provided fields.
      const sets = [];
      const params = { id: uid };
      const map = {
        firstname: 'firstname', lastname: 'lastname',
        user_type: 'user_type', role: 'role', nav_access: 'nav_access',
      };
      for (const [key, col] of Object.entries(map)) {
        if (key in b) { sets.push(`${col} = @${col}`); params[col] = b[key]; }
      }
      if ('active' in b) { sets.push('active = @active'); params.active = b.active ? 1 : 0; }
      if (params.user_type && params.user_type !== 'Admin') params.user_type = 'User';
      if (!sets.length) return badRequest('No updatable fields provided');

      const r = await mssql(
        `UPDATE dbo.Users SET ${sets.join(', ')} WHERE id = @id;
         SELECT ${LIST_COLS} FROM dbo.Users WHERE id = @id;`,
        params);
      return r.recordset[0] ? ok(r.recordset[0]) : notFound();
    }

    if (event.httpMethod === 'DELETE') {
      const uid = parseInt(id, 10);
      if (!uid) return badRequest('id is required');
      if (uid === me.id) return badRequest('You cannot deactivate your own account');
      const r = await mssql('UPDATE dbo.Users SET active = 0 WHERE id = @id', { id: uid });
      return r.rowsAffected[0] ? ok({ deactivated: true }) : notFound();
    }

    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
