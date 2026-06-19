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
          `SELECT l.*, CONCAT(s.firstname, ' ', s.lastname) AS assigned_name
           FROM tp_leads l LEFT JOIN tp_staff s ON s.id = l.assigned_id WHERE l.id = @id`, { id: parseInt(id, 10) });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const r = await mssql(
        `SELECT l.id,l.name,l.company,l.email,l.phone,l.value,l.status,l.source,l.last_contact,l.tags,l.created_at,
         CONCAT(s.firstname, ' ', s.lastname) AS assigned_name
         FROM tp_leads l LEFT JOIN tp_staff s ON s.id = l.assigned_id
         WHERE (@status IS NULL OR l.status = @status)
         AND (@search IS NULL OR l.name LIKE @search OR l.company LIKE @search OR l.email LIKE @search)
         ORDER BY l.created_at DESC`,
        { status: status || null, search: search ? `%${search}%` : null });
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await mssql(
        `INSERT INTO tp_leads (name,company,email,phone,value,assigned_id,status,source,tags,notes)
         VALUES (@name,@company,@email,@phone,@value,@assigned_id,@status,@source,@tags,@notes);
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
        { name: b.name || '', company: b.company || null, email: b.email || null, phone: b.phone || null,
          value: b.value || null, assigned_id: b.assigned_id || null, status: b.status || 'New',
          source: b.source || null, tags: b.tags || null, notes: b.notes || null });
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await mssql(
        `UPDATE tp_leads SET name=@name,company=@company,email=@email,phone=@phone,value=@value,assigned_id=@assigned_id,
         status=@status,source=@source,last_contact=@last_contact,tags=@tags,notes=@notes WHERE id=@id`,
        { name: b.name, company: b.company || null, email: b.email || null, phone: b.phone || null,
          value: b.value || null, assigned_id: b.assigned_id || null, status: b.status,
          source: b.source || null, last_contact: b.last_contact || null, tags: b.tags || null,
          notes: b.notes || null, id: parseInt(id, 10) });
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await mssql('DELETE FROM tp_leads WHERE id = @id', { id: parseInt(id, 10) });
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
