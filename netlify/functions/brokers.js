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
          .query('SELECT * FROM tp_brokers WHERE id = @id');
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const search = (event.queryStringParameters?.search || '').trim();
      const req = pool.request();
      let where = '';
      if (search) { req.input('s', sql.NVarChar, `%${search}%`); where = 'WHERE name LIKE @s OR email LIKE @s'; }
      const r = await req.query(`SELECT * FROM tp_brokers ${where} ORDER BY name`);
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await pool.request()
        .input('name',    sql.NVarChar, b.name    || '')
        .input('status',  sql.NVarChar, b.status  || 'Active')
        .input('address', sql.NVarChar, b.address || null)
        .input('email',   sql.NVarChar, b.email   || null)
        .input('phone',   sql.NVarChar, b.phone   || null)
        .query(`INSERT INTO tp_brokers (name,status,address,email,phone) OUTPUT INSERTED.id
                VALUES (@name,@status,@address,@email,@phone)`);
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await pool.request()
        .input('id',      sql.Int, id)
        .input('name',    sql.NVarChar, b.name)
        .input('status',  sql.NVarChar, b.status  || 'Active')
        .input('address', sql.NVarChar, b.address || null)
        .input('email',   sql.NVarChar, b.email   || null)
        .input('phone',   sql.NVarChar, b.phone   || null)
        .query('UPDATE tp_brokers SET name=@name,status=@status,address=@address,email=@email,phone=@phone WHERE id=@id');
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await pool.request().input('id', sql.Int, id).query('DELETE FROM tp_brokers WHERE id=@id');
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
