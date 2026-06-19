const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id, search } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await mssql(
          `SELECT c.*, co.name AS company, co.id AS company_id, b.name AS broker, b.id AS broker_id,
           CONCAT(s.firstname, ' ', s.lastname) AS coordinator
           FROM tp_clients c
           LEFT JOIN tp_companies co ON co.id = c.company_id
           LEFT JOIN tp_brokers b ON b.id = c.broker_id
           LEFT JOIN tp_staff s ON s.id = c.account_coordinator
           WHERE c.id = @id`, { id: parseInt(id, 10) });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const r = await mssql(
        `SELECT c.id, c.firstname, c.lastname, c.email, c.phone, c.active, c.groups, c.created_at,
         co.name AS company, co.id AS company_id, b.name AS broker, b.id AS broker_id,
         CONCAT(s.firstname, ' ', s.lastname) AS coordinator
         FROM tp_clients c
         LEFT JOIN tp_companies co ON co.id = c.company_id
         LEFT JOIN tp_brokers b ON b.id = c.broker_id
         LEFT JOIN tp_staff s ON s.id = c.account_coordinator
         WHERE (@search IS NULL OR CONCAT(c.firstname, ' ', c.lastname) LIKE @search
                OR c.email LIKE @search OR co.name LIKE @search)
         ORDER BY c.created_at DESC`,
        { search: search ? `%${search}%` : null });
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const r = await mssql(
        `INSERT INTO tp_clients (firstname, lastname, email, phone, company_id, broker_id, account_coordinator, groups, notes, irx_client_id)
         VALUES (@firstname,@lastname,@email,@phone,@company_id,@broker_id,@account_coordinator,@groups,@notes,@irx_client_id);
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
        { firstname: b.firstname || '', lastname: b.lastname || '', email: b.email || null, phone: b.phone || null,
          company_id: parseInt(b.company_id) || null, broker_id: parseInt(b.broker_id) || null,
          account_coordinator: parseInt(b.account_coordinator) || null, groups: b.groups || null,
          notes: b.notes || null, irx_client_id: b.irx_client_id || null });
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await mssql(
        `UPDATE tp_clients SET firstname=@firstname, lastname=@lastname, email=@email, phone=@phone, active=@active,
         company_id=@company_id, broker_id=@broker_id, account_coordinator=@account_coordinator,
         groups=@groups, notes=@notes, irx_client_id=@irx_client_id WHERE id=@id`,
        { firstname: b.firstname, lastname: b.lastname, email: b.email || null, phone: b.phone || null,
          active: (b.active !== false && b.active !== 0) ? 1 : 0,
          company_id: parseInt(b.company_id) || null, broker_id: parseInt(b.broker_id) || null,
          account_coordinator: parseInt(b.account_coordinator) || null, groups: b.groups || null,
          notes: b.notes || null, irx_client_id: b.irx_client_id || null, id: parseInt(id, 10) });
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
