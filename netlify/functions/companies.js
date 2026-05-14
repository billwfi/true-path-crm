const { getPool, sql } = require('./_db');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id } = event.queryStringParameters || {};

  try {
    const pool = await getPool();

    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await pool.request().input('id', sql.Int, id)
          .query('SELECT * FROM tp_companies WHERE id = @id');
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const search = (event.queryStringParameters?.search || '').trim();
      const req = pool.request();
      let where = '';
      if (search) { req.input('s', sql.NVarChar, `%${search}%`); where = 'WHERE name LIKE @s OR city LIKE @s OR state LIKE @s'; }
      const r = await req.query(`SELECT * FROM tp_companies ${where} ORDER BY name`);
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await pool.request()
        .input('name',    sql.NVarChar, b.name     || '')
        .input('phone',   sql.NVarChar, b.phone    || null)
        .input('address', sql.NVarChar, b.address  || null)
        .input('city',    sql.NVarChar, b.city     || null)
        .input('state',   sql.NVarChar, b.state    || null)
        .input('zip',     sql.NVarChar, b.zip_code || null)
        .query(`INSERT INTO tp_companies (name,phone,address,city,state,zip_code) OUTPUT INSERTED.id
                VALUES (@name,@phone,@address,@city,@state,@zip)`);
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await pool.request()
        .input('id',      sql.Int, id)
        .input('name',    sql.NVarChar, b.name)
        .input('phone',   sql.NVarChar, b.phone    || null)
        .input('address', sql.NVarChar, b.address  || null)
        .input('city',    sql.NVarChar, b.city     || null)
        .input('state',   sql.NVarChar, b.state    || null)
        .input('zip',     sql.NVarChar, b.zip_code || null)
        .query('UPDATE tp_companies SET name=@name,phone=@phone,address=@address,city=@city,state=@state,zip_code=@zip WHERE id=@id');
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await pool.request().input('id', sql.Int, id).query('DELETE FROM tp_companies WHERE id=@id');
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
