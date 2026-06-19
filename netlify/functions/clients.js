const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

// A "client" is an organization/company. Sub-resources (contacts, contracts) key on
// tp_clients.id; the Eligibility tab keys on irx_client_id (= eligibility CARRIER).
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id, search } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await mssql(
          `SELECT c.*, b.name AS broker, b.id AS broker_id,
           CONCAT(s.firstname, ' ', s.lastname) AS coordinator
           FROM tp_clients c
           LEFT JOIN tp_brokers b ON b.id = c.broker_id
           LEFT JOIN tp_staff s ON s.id = c.account_coordinator
           WHERE c.id = @id`, { id: parseInt(id, 10) });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const r = await mssql(
        `SELECT c.id, c.name, c.email, c.phone, c.city, c.state, c.active, c.groups,
                c.irx_client_id, c.created_at, b.name AS broker, b.id AS broker_id
         FROM tp_clients c
         LEFT JOIN tp_brokers b ON b.id = c.broker_id
         WHERE (@search IS NULL OR c.name LIKE @search OR c.email LIKE @search
                OR c.irx_client_id LIKE @search OR c.city LIKE @search)
         ORDER BY c.name`,
        { search: search ? `%${search}%` : null });
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await mssql(
        `INSERT INTO tp_clients (name, email, phone, address, city, state, zip_code,
           broker_id, account_coordinator, groups, notes, irx_client_id, active)
         VALUES (@name,@email,@phone,@address,@city,@state,@zip_code,
           @broker_id,@account_coordinator,@groups,@notes,@irx_client_id,@active);
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
        { name: b.name || '', email: b.email || null, phone: b.phone || null,
          address: b.address || null, city: b.city || null, state: b.state || null, zip_code: b.zip_code || null,
          broker_id: parseInt(b.broker_id) || null, account_coordinator: parseInt(b.account_coordinator) || null,
          groups: b.groups || null, notes: b.notes || null, irx_client_id: b.irx_client_id || null,
          active: (b.active === false || b.active === 0) ? 0 : 1 });
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await mssql(
        `UPDATE tp_clients SET name=@name, email=@email, phone=@phone, address=@address, city=@city,
           state=@state, zip_code=@zip_code, active=@active, broker_id=@broker_id,
           account_coordinator=@account_coordinator, groups=@groups, notes=@notes, irx_client_id=@irx_client_id
         WHERE id=@id`,
        { name: b.name, email: b.email || null, phone: b.phone || null, address: b.address || null,
          city: b.city || null, state: b.state || null, zip_code: b.zip_code || null,
          active: (b.active !== false && b.active !== 0) ? 1 : 0,
          broker_id: parseInt(b.broker_id) || null, account_coordinator: parseInt(b.account_coordinator) || null,
          groups: b.groups || null, notes: b.notes || null, irx_client_id: b.irx_client_id || null,
          id: parseInt(id, 10) });
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await mssql('DELETE FROM tp_clients WHERE id = @id', { id: parseInt(id, 10) });
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
