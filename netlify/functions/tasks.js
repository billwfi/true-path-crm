const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id, status, search } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await mssql(
          `SELECT t.*, CONCAT(s.firstname, ' ', s.lastname) AS assigned_name
           FROM tp_tasks t LEFT JOIN tp_staff s ON s.id = t.assigned_id WHERE t.id = @id`, { id: parseInt(id, 10) });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const r = await mssql(
        `SELECT t.id,t.name,t.status,t.priority,t.start_date,t.due_date,t.tags,t.color,t.related_type,t.related_id,t.created_at,
         CONCAT(s.firstname, ' ', s.lastname) AS assigned_name
         FROM tp_tasks t LEFT JOIN tp_staff s ON s.id = t.assigned_id
         WHERE (@status IS NULL OR t.status = @status)
         AND (@search IS NULL OR t.name LIKE @search)
         ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date ASC, t.created_at DESC`,
        { status: status || null, search: search ? `%${search}%` : null });
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await mssql(
        `INSERT INTO tp_tasks (name,status,priority,start_date,due_date,assigned_id,tags,color,related_type,related_id,description)
         VALUES (@name,@status,@priority,@start_date,@due_date,@assigned_id,@tags,@color,@related_type,@related_id,@description);
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
        { name: b.name || '', status: b.status || 'Not Started', priority: b.priority || 'Medium',
          start_date: b.start_date || null, due_date: b.due_date || null, assigned_id: b.assigned_id || null,
          tags: b.tags || null, color: b.color || null, related_type: b.related_type || null,
          related_id: b.related_id || null, description: b.description || null });
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await mssql(
        `UPDATE tp_tasks SET name=@name,status=@status,priority=@priority,start_date=@start_date,due_date=@due_date,
         assigned_id=@assigned_id,tags=@tags,color=@color,description=@description WHERE id=@id`,
        { name: b.name, status: b.status, priority: b.priority, start_date: b.start_date || null,
          due_date: b.due_date || null, assigned_id: b.assigned_id || null, tags: b.tags || null,
          color: b.color || null, description: b.description || null, id: parseInt(id, 10) });
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await mssql('DELETE FROM tp_tasks WHERE id = @id', { id: parseInt(id, 10) });
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
