const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id, search } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await mssql('SELECT * FROM tp_companies WHERE id = @id', { id: parseInt(id, 10) });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const r = await mssql(
        `SELECT * FROM tp_companies
         WHERE (@search IS NULL OR name LIKE @search OR city LIKE @search OR state LIKE @search)
         ORDER BY name`,
        { search: search ? `%${search}%` : null });
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await mssql(
        `INSERT INTO tp_companies (name,phone,address,city,state,zip_code)
         VALUES (@name,@phone,@address,@city,@state,@zip_code);
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
        { name: b.name || '', phone: b.phone || null, address: b.address || null,
          city: b.city || null, state: b.state || null, zip_code: b.zip_code || null });
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await mssql(
        `UPDATE tp_companies SET name=@name,phone=@phone,address=@address,city=@city,state=@state,zip_code=@zip_code
         WHERE id=@id`,
        { name: b.name, phone: b.phone || null, address: b.address || null, city: b.city || null,
          state: b.state || null, zip_code: b.zip_code || null, id: parseInt(id, 10) });
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await mssql('DELETE FROM tp_companies WHERE id = @id', { id: parseInt(id, 10) });
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
