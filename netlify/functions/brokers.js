const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id, search } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await mssql('SELECT * FROM tp_brokers WHERE id = @id', { id: parseInt(id, 10) });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const r = await mssql(
        `SELECT * FROM tp_brokers
         WHERE (@search IS NULL OR name LIKE @search OR email LIKE @search)
         ORDER BY name`,
        { search: search ? `%${search}%` : null });
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await mssql(
        `INSERT INTO tp_brokers (name,status,address,email,phone)
         VALUES (@name,@status,@address,@email,@phone);
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
        { name: b.name || '', status: b.status || 'Active', address: b.address || null,
          email: b.email || null, phone: b.phone || null });
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await mssql(
        `UPDATE tp_brokers SET name=@name,status=@status,address=@address,email=@email,phone=@phone WHERE id=@id`,
        { name: b.name, status: b.status || 'Active', address: b.address || null,
          email: b.email || null, phone: b.phone || null, id: parseInt(id, 10) });
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await mssql('DELETE FROM tp_brokers WHERE id = @id', { id: parseInt(id, 10) });
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
