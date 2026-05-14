const { getPool, sql } = require('./_db');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

const COLS = `c.id, c.firstname, c.lastname, c.email, c.phone, c.active, c.groups, c.notes, c.created_at,
  co.name AS company, co.id AS company_id,
  b.name AS broker, b.id AS broker_id,
  ISNULL(s.firstname,'') + ' ' + ISNULL(s.lastname,'') AS coordinator`;

const FROM = `FROM tp_clients c
  LEFT JOIN tp_companies co ON co.id = c.company_id
  LEFT JOIN tp_brokers b ON b.id = c.broker_id
  LEFT JOIN tp_staff s ON s.id = c.account_coordinator`;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id } = event.queryStringParameters || {};

  try {
    const pool = await getPool();
    // GET list or single
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await pool.request().input('id', sql.Int, id)
          .query(`SELECT ${COLS} ${FROM} WHERE c.id = @id`);
        if (!r.recordset[0]) return notFound();
        return ok(r.recordset[0]);
      }
      const search = (event.queryStringParameters?.search || '').trim();
      const req = pool.request();
      let where = '';
      if (search) {
        req.input('search', sql.NVarChar, `%${search}%`);
        where = `WHERE c.firstname+' '+c.lastname LIKE @search OR c.email LIKE @search OR co.name LIKE @search`;
      }
      const r = await req.query(`SELECT ${COLS} ${FROM} ${where} ORDER BY c.created_at DESC`);
      return ok(r.recordset);
    }

    // POST create
    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await pool.request()
        .input('firstname', sql.NVarChar, b.firstname || '')
        .input('lastname',  sql.NVarChar, b.lastname  || '')
        .input('email',     sql.NVarChar, b.email     || null)
        .input('phone',     sql.NVarChar, b.phone     || null)
        .input('company_id',sql.Int, b.company_id     || null)
        .input('broker_id', sql.Int, b.broker_id      || null)
        .input('coordinator',sql.Int, b.account_coordinator || null)
        .input('groups',    sql.NVarChar, b.groups    || null)
        .input('notes',     sql.NVarChar, b.notes     || null)
        .query(`INSERT INTO tp_clients (firstname,lastname,email,phone,company_id,broker_id,account_coordinator,groups,notes)
                OUTPUT INSERTED.id
                VALUES (@firstname,@lastname,@email,@phone,@company_id,@broker_id,@coordinator,@groups,@notes)`);
      return created({ id: r.recordset[0].id });
    }

    // PATCH update
    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await pool.request()
        .input('id',        sql.Int, id)
        .input('firstname', sql.NVarChar, b.firstname)
        .input('lastname',  sql.NVarChar, b.lastname)
        .input('email',     sql.NVarChar, b.email     || null)
        .input('phone',     sql.NVarChar, b.phone     || null)
        .input('active',    sql.Bit, b.active !== undefined ? b.active : 1)
        .input('company_id',sql.Int, b.company_id     || null)
        .input('broker_id', sql.Int, b.broker_id      || null)
        .input('coordinator',sql.Int, b.account_coordinator || null)
        .input('groups',    sql.NVarChar, b.groups    || null)
        .input('notes',     sql.NVarChar, b.notes     || null)
        .query(`UPDATE tp_clients SET firstname=@firstname,lastname=@lastname,email=@email,phone=@phone,
                active=@active,company_id=@company_id,broker_id=@broker_id,account_coordinator=@coordinator,
                groups=@groups,notes=@notes WHERE id=@id`);
      return ok({ id });
    }

    // DELETE
    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await pool.request().input('id', sql.Int, id)
        .query('DELETE FROM tp_clients WHERE id = @id');
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
