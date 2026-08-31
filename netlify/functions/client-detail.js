const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options, CORS } = require('./_auth');

// Client detail sub-resources stored in SQL Server, keyed by client_id
// (tp_clients.id in Postgres) / contract_id. Resources: contact | contract | benefit.
//   GET    ?client_id=X                      -> { contacts, contracts:[{...,benefits}] }
//   POST   ?resource=contact&client_id=X
//   POST   ?resource=contract&client_id=X
//   POST   ?resource=benefit&contract_id=Z
//   PATCH  ?resource=<r>&id=Y
//   DELETE ?resource=<r>&id=Y

const CONTRACT_STATUSES = ['Active', 'Pending', 'Expired', 'Cancelled'];
const BENEFIT_TYPES = ['iRx', 'GLP1'];
const benefitType = (t) => (BENEFIT_TYPES.includes(t) ? t : 'iRx');
// GLP1 drug amounts only apply to GLP1 benefits; otherwise null.
const drugAmt = (type, v) => (benefitType(type) === 'GLP1' && v != null && v !== '' ? Number(v) : null);

// Smart contract number: <CLIENT-CODE>-<YEAR>-<NNN>. CODE is the client's irx_client_id
// (or initials/slug of the name); YEAR from the effective date (else current); NNN is the
// next sequence for that client + year, so numbers are meaningful and readable.
async function nextContractNumber(cid, effDate) {
  const cli = (await mssql('SELECT irx_client_id, name FROM dbo.tp_clients WHERE id=@id', { id: cid })).recordset[0] || {};
  let code = (cli.irx_client_id || '').toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!code) {
    const words = (cli.name || 'CLIENT').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    code = words.length > 1 ? words.slice(0, 3).map(w => w[0]).join('') : (words[0] || 'CLIENT').slice(0, 4);
  }
  code = (code || 'CLIENT').slice(0, 12);
  const yr = effDate ? new Date(effDate).getFullYear() : NaN;
  const year = Number.isFinite(yr) ? yr : new Date().getFullYear();
  const prefix = `${code}-${year}-`;
  const rows = (await mssql(
    `SELECT contract_number FROM dbo.Client_Contracts WHERE client_id=@id AND contract_number LIKE @p`,
    { id: cid, p: prefix + '%' })).recordset;
  let max = 0;
  for (const r of rows) {
    const m = /-(\d+)\s*$/.exec(r.contract_number || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return prefix + String(max + 1).padStart(3, '0');
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  const { client_id, contract_id, id, resource, carrier, search } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (resource === 'eligibility') {
        // Read-only eligibility roster from irx.dbo.eligibility, matched on CARRIER
        // (the client's irx_client_id). GROUP is a reserved word -> bracketed.
        if (!carrier) return badRequest('carrier is required');
        const r = await mssql(
          `SELECT TOP 1000 MEMBER_ID, LAST_NAME, FIRST_NAME, DATE_OF_BIRTH, SEX,
                  RELATIONSHIP_CODE, MEMBER_TYPE, CARRIER, ACCOUNT, [GROUP] AS GRP, GroupName,
                  MEMBER_FROM_DATE, MEMBER_THRU_DATE, ADDRESS_1, ADDRESS_2, CITY, STATE, ZIP, PHONE, EMail_Address,
                  AccountStatus
           FROM dbo.eligibility
           WHERE CARRIER = @carrier
             AND (@search IS NULL OR LAST_NAME LIKE @search OR FIRST_NAME LIKE @search OR MEMBER_ID LIKE @search)
           ORDER BY LAST_NAME, FIRST_NAME`,
          { carrier, search: search ? `%${search}%` : null });
        return ok(r.recordset);
      }

      const cid = parseInt(client_id, 10);
      if (!cid) return badRequest('client_id is required');
      const contacts = await mssql(
        `SELECT id, client_id, name, title, email, phone, notes, created_at
         FROM dbo.Client_Contacts WHERE client_id = @cid ORDER BY name`, { cid });
      const contracts = await mssql(
        `SELECT id, client_id, name, contract_number, effective_date, end_date, status, notes, created_at, updated_at
         FROM dbo.Client_Contracts WHERE client_id = @cid ORDER BY created_at DESC`, { cid });
      const ids = contracts.recordset.map(c => c.id);
      let benefits = [];
      if (ids.length) {
        const inList = ids.map((_, i) => `@b${i}`).join(',');
        const params = {};
        ids.forEach((v, i) => params['b' + i] = v);
        const r = await mssql(
          `SELECT id, contract_id, name, type, coverage, value, notes,
                  tirzepatide_amount, semaglutide_amount, created_at
           FROM dbo.Client_Contract_Benefits WHERE contract_id IN (${inList}) ORDER BY name`, params);
        benefits = r.recordset;
      }
      const byContract = {};
      benefits.forEach(b => (byContract[b.contract_id] = byContract[b.contract_id] || []).push(b));
      const withBenefits = contracts.recordset.map(c => ({ ...c, benefits: byContract[c.id] || [] }));
      return ok({ contacts: contacts.recordset, contracts: withBenefits });
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');

      if (resource === 'contact') {
        const cid = parseInt(client_id, 10);
        if (!cid) return badRequest('client_id is required');
        if (!b.name) return badRequest('name is required');
        const r = await mssql(
          `INSERT INTO dbo.Client_Contacts (client_id, name, title, email, phone, notes, created_by)
           OUTPUT INSERTED.* VALUES (@cid, @name, @title, @email, @phone, @notes, @by)`,
          { cid, name: b.name, title: b.title || null, email: b.email || null,
            phone: b.phone || null, notes: b.notes || null, by: user.id || null });
        return created(r.recordset[0]);
      }

      if (resource === 'contract') {
        const cid = parseInt(client_id, 10);
        if (!cid) return badRequest('client_id is required');
        if (!b.name) return badRequest('name is required');
        const status = CONTRACT_STATUSES.includes(b.status) ? b.status : 'Active';
        // Smart-name the contract number when none is supplied: <CLIENT-CODE>-<YEAR>-<NNN>.
        const num = (b.contract_number || '').trim() || await nextContractNumber(cid, b.effective_date);
        const r = await mssql(
          `INSERT INTO dbo.Client_Contracts
             (client_id, name, contract_number, effective_date, end_date, status, notes, created_by)
           OUTPUT INSERTED.*
           VALUES (@cid, @name, @num, @eff, @end, @status, @notes, @by)`,
          { cid, name: b.name, num,
            eff: b.effective_date || null, end: b.end_date || null,
            status, notes: b.notes || null, by: user.id || null });
        return created({ ...r.recordset[0], benefits: [] });
      }

      if (resource === 'benefit') {
        const ctid = parseInt(contract_id, 10);
        if (!ctid) return badRequest('contract_id is required');
        if (!b.name) return badRequest('name is required');
        const r = await mssql(
          `INSERT INTO dbo.Client_Contract_Benefits
             (contract_id, name, type, coverage, value, notes, tirzepatide_amount, semaglutide_amount)
           OUTPUT INSERTED.*
           VALUES (@ctid, @name, @type, @coverage, @value, @notes, @tirz, @sema)`,
          { ctid, name: b.name, type: benefitType(b.type), coverage: b.coverage || null,
            value: b.value || null, notes: b.notes || null,
            tirz: drugAmt(b.type, b.tirzepatide_amount), sema: drugAmt(b.type, b.semaglutide_amount) });
        return created(r.recordset[0]);
      }

      return badRequest('unknown resource');
    }

    if (event.httpMethod === 'PATCH') {
      const rid = parseInt(id, 10);
      if (!rid) return badRequest('id is required');
      const b = JSON.parse(event.body || '{}');

      if (resource === 'contact') {
        const r = await mssql(
          `UPDATE dbo.Client_Contacts SET name=@name, title=@title, email=@email, phone=@phone, notes=@notes
           OUTPUT INSERTED.* WHERE id=@id`,
          { id: rid, name: b.name, title: b.title || null, email: b.email || null,
            phone: b.phone || null, notes: b.notes || null });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }

      if (resource === 'contract') {
        const status = CONTRACT_STATUSES.includes(b.status) ? b.status : 'Active';
        const r = await mssql(
          `UPDATE dbo.Client_Contracts
           SET name=@name, contract_number=@num, effective_date=@eff, end_date=@end,
               status=@status, notes=@notes, updated_at=GETDATE()
           OUTPUT INSERTED.* WHERE id=@id`,
          { id: rid, name: b.name, num: b.contract_number || null,
            eff: b.effective_date || null, end: b.end_date || null,
            status, notes: b.notes || null });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }

      if (resource === 'benefit') {
        const r = await mssql(
          `UPDATE dbo.Client_Contract_Benefits
           SET name=@name, type=@type, coverage=@coverage, value=@value, notes=@notes,
               tirzepatide_amount=@tirz, semaglutide_amount=@sema
           OUTPUT INSERTED.* WHERE id=@id`,
          { id: rid, name: b.name, type: benefitType(b.type), coverage: b.coverage || null,
            value: b.value || null, notes: b.notes || null,
            tirz: drugAmt(b.type, b.tirzepatide_amount), sema: drugAmt(b.type, b.semaglutide_amount) });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }

      return badRequest('unknown resource');
    }

    if (event.httpMethod === 'DELETE') {
      const rid = parseInt(id, 10);
      if (!rid) return badRequest('id is required');

      if (resource === 'contact') {
        const r = await mssql('DELETE FROM dbo.Client_Contacts WHERE id=@id', { id: rid });
        return r.rowsAffected[0] ? ok({ deleted: true }) : notFound();
      }
      if (resource === 'contract') {
        // Remove the contract and its benefits.
        await mssql('DELETE FROM dbo.Client_Contract_Benefits WHERE contract_id=@id', { id: rid });
        const r = await mssql('DELETE FROM dbo.Client_Contracts WHERE id=@id', { id: rid });
        return r.rowsAffected[0] ? ok({ deleted: true }) : notFound();
      }
      if (resource === 'benefit') {
        const r = await mssql('DELETE FROM dbo.Client_Contract_Benefits WHERE id=@id', { id: rid });
        return r.rowsAffected[0] ? ok({ deleted: true }) : notFound();
      }
      return badRequest('unknown resource');
    }

    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
