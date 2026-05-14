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
          .query(`SELECT t.*, ISNULL(s.firstname,'')+' '+ISNULL(s.lastname,'') AS assigned_name
                  FROM tp_tasks t LEFT JOIN tp_staff s ON s.id = t.assigned_id WHERE t.id = @id`);
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const req = pool.request();
      const search = (event.queryStringParameters?.search || '').trim();
      const status = event.queryStringParameters?.status || '';
      let where = 'WHERE 1=1';
      if (status) { req.input('status', sql.NVarChar, status); where += ' AND t.status = @status'; }
      if (search) { req.input('search', sql.NVarChar, `%${search}%`); where += ' AND t.name LIKE @search'; }
      const r = await req.query(
        `SELECT t.id,t.name,t.status,t.priority,t.start_date,t.due_date,t.tags,t.color,t.related_type,t.related_id,t.created_at,
         ISNULL(s.firstname,'')+' '+ISNULL(s.lastname,'') AS assigned_name
         FROM tp_tasks t LEFT JOIN tp_staff s ON s.id = t.assigned_id ${where} ORDER BY t.due_date ASC, t.created_at DESC`);
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await pool.request()
        .input('name',        sql.NVarChar, b.name || '')
        .input('status',      sql.NVarChar, b.status || 'Not Started')
        .input('priority',    sql.NVarChar, b.priority || 'Medium')
        .input('start_date',  sql.Date, b.start_date || null)
        .input('due_date',    sql.Date, b.due_date   || null)
        .input('assigned_id', sql.Int,  b.assigned_id || null)
        .input('tags',        sql.NVarChar, b.tags   || null)
        .input('color',       sql.NVarChar, b.color  || null)
        .input('related_type',sql.NVarChar, b.related_type || null)
        .input('related_id',  sql.Int, b.related_id  || null)
        .input('description', sql.NVarChar, b.description || null)
        .query(`INSERT INTO tp_tasks (name,status,priority,start_date,due_date,assigned_id,tags,color,related_type,related_id,description)
                OUTPUT INSERTED.id VALUES (@name,@status,@priority,@start_date,@due_date,@assigned_id,@tags,@color,@related_type,@related_id,@description)`);
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await pool.request()
        .input('id',          sql.Int, id)
        .input('name',        sql.NVarChar, b.name)
        .input('status',      sql.NVarChar, b.status)
        .input('priority',    sql.NVarChar, b.priority)
        .input('start_date',  sql.Date, b.start_date || null)
        .input('due_date',    sql.Date, b.due_date   || null)
        .input('assigned_id', sql.Int, b.assigned_id || null)
        .input('tags',        sql.NVarChar, b.tags   || null)
        .input('color',       sql.NVarChar, b.color  || null)
        .input('description', sql.NVarChar, b.description || null)
        .query(`UPDATE tp_tasks SET name=@name,status=@status,priority=@priority,start_date=@start_date,
                due_date=@due_date,assigned_id=@assigned_id,tags=@tags,color=@color,description=@description WHERE id=@id`);
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await pool.request().input('id', sql.Int, id).query('DELETE FROM tp_tasks WHERE id=@id');
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
