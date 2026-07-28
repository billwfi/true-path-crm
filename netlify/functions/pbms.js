const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

// A "PBM" (pharmacy benefit manager, e.g. Liviniti) mirrors the client entity.
// Sub-resources (contacts, contracts, groups) key on tp_pbms.id via pbm-detail.js.
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  const { id, search } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await mssql('SELECT * FROM dbo.tp_pbms WHERE id = @id', { id: parseInt(id, 10) });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const r = await mssql(
        `SELECT p.id, p.name, p.pbm_code, p.email, p.phone, p.city, p.state, p.active, p.created_at,
                (SELECT COUNT(*) FROM dbo.PBM_Groups g WHERE g.pbm_id = p.id) AS groups
         FROM dbo.tp_pbms p
         WHERE (@search IS NULL OR p.name LIKE @search OR p.pbm_code LIKE @search OR p.city LIKE @search)
         ORDER BY p.name`,
        { search: search ? `%${search}%` : null });
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      if (!b.name) return badRequest('name is required');
      const r = await mssql(
        `INSERT INTO dbo.tp_pbms (name, pbm_code, carrier, email, phone, website, sftp_host,
           address, city, state, zip_code, account_coordinator, notes, active, created_by)
         VALUES (@name,@code,@carrier,@email,@phone,@website,@sftp,@address,@city,@state,@zip,
           @coord,@notes,@active,@by);
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
        { name: b.name, code: b.pbm_code || null, carrier: b.carrier || null, email: b.email || null,
          phone: b.phone || null, website: b.website || null, sftp: b.sftp_host || null,
          address: b.address || null, city: b.city || null, state: b.state || null, zip: b.zip_code || null,
          coord: b.account_coordinator || null, notes: b.notes || null,
          active: (b.active === false || b.active === 0) ? 0 : 1, by: user.id || null });
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await mssql(
        `UPDATE dbo.tp_pbms SET name=@name, pbm_code=@code, carrier=@carrier, email=@email, phone=@phone,
           website=@website, sftp_host=@sftp, address=@address, city=@city, state=@state, zip_code=@zip,
           account_coordinator=@coord, notes=@notes, active=@active, updated_at=GETDATE()
         WHERE id=@id`,
        { name: b.name, code: b.pbm_code || null, carrier: b.carrier || null, email: b.email || null,
          phone: b.phone || null, website: b.website || null, sftp: b.sftp_host || null,
          address: b.address || null, city: b.city || null, state: b.state || null, zip: b.zip_code || null,
          coord: b.account_coordinator || null, notes: b.notes || null,
          active: (b.active !== false && b.active !== 0) ? 1 : 0, id: parseInt(id, 10) });
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      const pid = parseInt(id, 10);
      await mssql(
        `DELETE FROM dbo.PBM_Contract_Benefits WHERE contract_id IN (SELECT id FROM dbo.PBM_Contracts WHERE pbm_id=@id);
         DELETE FROM dbo.PBM_Contracts WHERE pbm_id=@id;
         DELETE FROM dbo.PBM_Contacts  WHERE pbm_id=@id;
         DELETE FROM dbo.PBM_Groups    WHERE pbm_id=@id;
         DELETE FROM dbo.tp_pbms       WHERE id=@id;`, { id: pid });
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
