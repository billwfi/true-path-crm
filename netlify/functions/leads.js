const { getPool, sql } = require('./_db');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id, status } = event.queryStringParameters || {};

  try {
    const pool = await getPool();

    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await pool.request().input('id', sql.Int, id)
          .query(`SELECT l.*, ISNULL(s.firstname,'')+' '+ISNULL(s.lastname,'') AS assigned_name
                  FROM tp_leads l LEFT JOIN tp_staff s ON s.id = l.assigned_id WHERE l.id = @id`);
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const req = pool.request();
      const search = (event.queryStringParameters?.search || '').trim();
      let where = 'WHERE 1=1';
      if (status) { req.input('status', sql.NVarChar, status); where += ' AND l.status = @status'; }
      if (search) { req.input('search', sql.NVarChar, `%${search}%`); where += ' AND (l.name LIKE @search OR l.company LIKE @search OR l.email LIKE @search)'; }
      const r = await req.query(
        `SELECT l.id,l.name,l.company,l.email,l.phone,l.value,l.status,l.source,l.last_contact,l.tags,l.created_at,
         ISNULL(s.firstname,'')+' '+ISNULL(s.lastname,'') AS assigned_name
         FROM tp_leads l LEFT JOIN tp_staff s ON s.id = l.assigned_id ${where} ORDER BY l.created_at DESC`);
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await pool.request()
        .input('name',        sql.NVarChar, b.name || '')
        .input('company',     sql.NVarChar, b.company   || null)
        .input('email',       sql.NVarChar, b.email     || null)
        .input('phone',       sql.NVarChar, b.phone     || null)
        .input('value',       sql.Decimal, b.value      || null)
        .input('assigned_id', sql.Int, b.assigned_id    || null)
        .input('status',      sql.NVarChar, b.status || 'New')
        .input('source',      sql.NVarChar, b.source    || null)
        .input('tags',        sql.NVarChar, b.tags      || null)
        .input('notes',       sql.NVarChar, b.notes     || null)
        .query(`INSERT INTO tp_leads (name,company,email,phone,value,assigned_id,status,source,tags,notes)
                OUTPUT INSERTED.id VALUES (@name,@company,@email,@phone,@value,@assigned_id,@status,@source,@tags,@notes)`);
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await pool.request()
        .input('id',          sql.Int, id)
        .input('name',        sql.NVarChar, b.name)
        .input('company',     sql.NVarChar, b.company)
        .input('email',       sql.NVarChar, b.email     || null)
        .input('phone',       sql.NVarChar, b.phone     || null)
        .input('value',       sql.Decimal, b.value      || null)
        .input('assigned_id', sql.Int, b.assigned_id    || null)
        .input('status',      sql.NVarChar, b.status)
        .input('source',      sql.NVarChar, b.source    || null)
        .input('last_contact',sql.DateTime2, b.last_contact || null)
        .input('tags',        sql.NVarChar, b.tags      || null)
        .input('notes',       sql.NVarChar, b.notes     || null)
        .query(`UPDATE tp_leads SET name=@name,company=@company,email=@email,phone=@phone,value=@value,
                assigned_id=@assigned_id,status=@status,source=@source,last_contact=@last_contact,
                tags=@tags,notes=@notes WHERE id=@id`);
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await pool.request().input('id', sql.Int, id).query('DELETE FROM tp_leads WHERE id=@id');
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
