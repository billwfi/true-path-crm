const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options, CORS } = require('./_auth');

// PBM detail sub-resources, keyed by pbm_id / contract_id. Resources:
//   contact | contract | benefit | group
//   GET  ?pbm_id=X                          -> { contacts, contracts:[{...,benefits}] }
//   GET  ?resource=groups&pbm_id=X&search=  -> groups (+ member counts from eligibility/intake)
//   GET  ?resource=group-members&pbm_id=X&group_code=G  -> eligibility rows for a group
//   POST/PATCH/DELETE ?resource=<r>&id=

const CONTRACT_STATUSES = ['Active', 'Pending', 'Expired', 'Cancelled'];
const GROUP_STATUSES = ['Active', 'Inactive', 'Pending', 'Termed'];
const groupStatus = (s) => (GROUP_STATUSES.includes(s) ? s : 'Active');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  const { pbm_id, contract_id, id, resource, group_code, search } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      // ── Groups list (+ live member counts) ──────────────────────────────────
      if (resource === 'groups') {
        const pid = parseInt(pbm_id, 10);
        if (!pid) return badRequest('pbm_id is required');
        const groups = (await mssql(
          `SELECT id, pbm_id, tp_group_id, group_code, group_name, client_code, company_name, status, effective_date, notes, created_at, updated_at
           FROM dbo.PBM_Groups
           WHERE pbm_id=@pid
             AND (@s IS NULL OR tp_group_id LIKE @s OR group_code LIKE @s OR group_name LIKE @s OR company_name LIKE @s)
           ORDER BY tp_group_id`,
          { pid, s: search ? `%${search}%` : null })).recordset;

        // member counts by GroupID: SFTP eligibility (Liviniti table, if present) + API intake
        const counts = {};
        const hasElig = (await mssql("SELECT OBJECT_ID('dbo.Eligibility_Liviniti','U') oid")).recordset[0].oid;
        if (hasElig) {
          (await mssql('SELECT GroupID, COUNT(*) n FROM dbo.Eligibility_Liviniti GROUP BY GroupID')).recordset
            .forEach(r => { counts[r.GroupID] = (counts[r.GroupID] || 0) + r.n; });
        }
        (await mssql('SELECT GroupID, COUNT(*) n FROM dbo.PBM_Member_Intake WHERE pbm_id=@pid GROUP BY GroupID', { pid })).recordset
          .forEach(r => { counts[r.GroupID] = (counts[r.GroupID] || 0) + r.n; });

        return ok(groups.map(g => ({ ...g, members: counts[g.group_code] || 0 })));
      }

      // ── Eligibility rows for one group (SFTP + API intake) ──────────────────
      if (resource === 'group-members') {
        if (!group_code) return badRequest('group_code is required');
        const pid = parseInt(pbm_id, 10) || null;
        const hasElig = (await mssql("SELECT OBJECT_ID('dbo.Eligibility_Liviniti','U') oid")).recordset[0].oid;
        const parts = [];
        if (hasElig) parts.push(
          `SELECT TOP 1000 CardholderID AS MemberID, LastName, FirstName, DateOfBirth, GroupID, GroupName,
                  EffectiveStart, EffectiveEnd, EmailAddress, 'SFTP' AS Source
           FROM dbo.Eligibility_Liviniti WHERE GroupID=@gc
             AND (@s IS NULL OR LastName LIKE @s OR FirstName LIKE @s OR CardholderID LIKE @s)`);
        parts.push(
          `SELECT TOP 1000 CardholderID AS MemberID, LastName, FirstName, DateOfBirth, GroupID, GroupName,
                  EffectiveStart, EffectiveEnd, EmailAddress, 'API' AS Source
           FROM dbo.PBM_Member_Intake WHERE GroupID=@gc AND (@pid IS NULL OR pbm_id=@pid)
             AND (@s IS NULL OR LastName LIKE @s OR FirstName LIKE @s OR CardholderID LIKE @s)`);
        const r = await mssql(
          `SELECT TOP 1000 * FROM (${parts.join(' UNION ALL ')}) x ORDER BY LastName, FirstName`,
          { gc: group_code, pid, s: search ? `%${search}%` : null });
        return ok(r.recordset);
      }

      // ── Contacts + contracts (+ benefits) ───────────────────────────────────
      const pid = parseInt(pbm_id, 10);
      if (!pid) return badRequest('pbm_id is required');
      const contacts = await mssql(
        `SELECT id, pbm_id, name, title, email, phone, notes, created_at
         FROM dbo.PBM_Contacts WHERE pbm_id=@pid ORDER BY name`, { pid });
      const contracts = await mssql(
        `SELECT id, pbm_id, name, contract_number, effective_date, end_date, status, notes, created_at, updated_at
         FROM dbo.PBM_Contracts WHERE pbm_id=@pid ORDER BY created_at DESC`, { pid });
      const ids = contracts.recordset.map(c => c.id);
      let benefits = [];
      if (ids.length) {
        const inList = ids.map((_, i) => `@b${i}`).join(',');
        const params = {}; ids.forEach((v, i) => params['b' + i] = v);
        benefits = (await mssql(
          `SELECT id, contract_id, name, type, coverage, value, notes, created_at
           FROM dbo.PBM_Contract_Benefits WHERE contract_id IN (${inList}) ORDER BY name`, params)).recordset;
      }
      const byContract = {};
      benefits.forEach(b => (byContract[b.contract_id] = byContract[b.contract_id] || []).push(b));
      const withBenefits = contracts.recordset.map(c => ({ ...c, benefits: byContract[c.id] || [] }));
      return ok({ contacts: contacts.recordset, contracts: withBenefits });
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');

      if (resource === 'contact') {
        const pid = parseInt(pbm_id, 10);
        if (!pid) return badRequest('pbm_id is required');
        if (!b.name) return badRequest('name is required');
        const r = await mssql(
          `INSERT INTO dbo.PBM_Contacts (pbm_id, name, title, email, phone, notes, created_by)
           OUTPUT INSERTED.* VALUES (@pid,@name,@title,@email,@phone,@notes,@by)`,
          { pid, name: b.name, title: b.title || null, email: b.email || null,
            phone: b.phone || null, notes: b.notes || null, by: user.id || null });
        return created(r.recordset[0]);
      }

      if (resource === 'contract') {
        const pid = parseInt(pbm_id, 10);
        if (!pid) return badRequest('pbm_id is required');
        if (!b.name) return badRequest('name is required');
        const status = CONTRACT_STATUSES.includes(b.status) ? b.status : 'Active';
        const r = await mssql(
          `INSERT INTO dbo.PBM_Contracts (pbm_id, name, contract_number, effective_date, end_date, status, notes, created_by)
           OUTPUT INSERTED.* VALUES (@pid,@name,@num,@eff,@end,@status,@notes,@by)`,
          { pid, name: b.name, num: b.contract_number || null, eff: b.effective_date || null,
            end: b.end_date || null, status, notes: b.notes || null, by: user.id || null });
        return created({ ...r.recordset[0], benefits: [] });
      }

      if (resource === 'benefit') {
        const ctid = parseInt(contract_id, 10);
        if (!ctid) return badRequest('contract_id is required');
        if (!b.name) return badRequest('name is required');
        const r = await mssql(
          `INSERT INTO dbo.PBM_Contract_Benefits (contract_id, name, type, coverage, value, notes)
           OUTPUT INSERTED.* VALUES (@ctid,@name,@type,@coverage,@value,@notes)`,
          { ctid, name: b.name, type: b.type || null, coverage: b.coverage || null,
            value: b.value || null, notes: b.notes || null });
        return created(r.recordset[0]);
      }

      if (resource === 'group') {
        const pid = parseInt(pbm_id, 10);
        if (!pid) return badRequest('pbm_id is required');
        if (!b.group_code) return badRequest('group_code is required');
        const r = await mssql(
          `INSERT INTO dbo.PBM_Groups (pbm_id, group_code, group_name, client_code, company_name, status, effective_date, notes, created_by, tp_group_id)
           OUTPUT INSERTED.*
           VALUES (@pid,@code,@name,@client,@company,@status,@eff,@notes,@by,
                   'TP' + CAST(NEXT VALUE FOR dbo.PBM_TP_Group_Seq AS varchar(10)))`,
          { pid, code: b.group_code, name: b.group_name || null, client: b.client_code || null,
            company: b.company_name || null, status: groupStatus(b.status),
            eff: b.effective_date || null, notes: b.notes || null, by: user.id || null });
        return created({ ...r.recordset[0], members: 0 });
      }

      return badRequest('unknown resource');
    }

    if (event.httpMethod === 'PATCH') {
      const rid = parseInt(id, 10);
      if (!rid) return badRequest('id is required');
      const b = JSON.parse(event.body || '{}');

      if (resource === 'contact') {
        const r = await mssql(
          `UPDATE dbo.PBM_Contacts SET name=@name, title=@title, email=@email, phone=@phone, notes=@notes
           OUTPUT INSERTED.* WHERE id=@id`,
          { id: rid, name: b.name, title: b.title || null, email: b.email || null, phone: b.phone || null, notes: b.notes || null });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }

      if (resource === 'contract') {
        const status = CONTRACT_STATUSES.includes(b.status) ? b.status : 'Active';
        const r = await mssql(
          `UPDATE dbo.PBM_Contracts SET name=@name, contract_number=@num, effective_date=@eff, end_date=@end,
             status=@status, notes=@notes, updated_at=GETDATE() OUTPUT INSERTED.* WHERE id=@id`,
          { id: rid, name: b.name, num: b.contract_number || null, eff: b.effective_date || null,
            end: b.end_date || null, status, notes: b.notes || null });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }

      if (resource === 'benefit') {
        const r = await mssql(
          `UPDATE dbo.PBM_Contract_Benefits SET name=@name, type=@type, coverage=@coverage, value=@value, notes=@notes
           OUTPUT INSERTED.* WHERE id=@id`,
          { id: rid, name: b.name, type: b.type || null, coverage: b.coverage || null, value: b.value || null, notes: b.notes || null });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }

      if (resource === 'group') {
        const r = await mssql(
          `UPDATE dbo.PBM_Groups SET group_code=@code, group_name=@name, client_code=@client, company_name=@company,
             status=@status, effective_date=@eff, notes=@notes, updated_at=GETDATE()
           OUTPUT INSERTED.* WHERE id=@id`,
          { id: rid, code: b.group_code, name: b.group_name || null, client: b.client_code || null,
            company: b.company_name || null, status: groupStatus(b.status), eff: b.effective_date || null, notes: b.notes || null });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }

      return badRequest('unknown resource');
    }

    if (event.httpMethod === 'DELETE') {
      const rid = parseInt(id, 10);
      if (!rid) return badRequest('id is required');
      if (resource === 'contact') {
        const r = await mssql('DELETE FROM dbo.PBM_Contacts WHERE id=@id', { id: rid });
        return r.rowsAffected[0] ? ok({ deleted: true }) : notFound();
      }
      if (resource === 'contract') {
        await mssql('DELETE FROM dbo.PBM_Contract_Benefits WHERE contract_id=@id', { id: rid });
        const r = await mssql('DELETE FROM dbo.PBM_Contracts WHERE id=@id', { id: rid });
        return r.rowsAffected[0] ? ok({ deleted: true }) : notFound();
      }
      if (resource === 'benefit') {
        const r = await mssql('DELETE FROM dbo.PBM_Contract_Benefits WHERE id=@id', { id: rid });
        return r.rowsAffected[0] ? ok({ deleted: true }) : notFound();
      }
      if (resource === 'group') {
        const r = await mssql('DELETE FROM dbo.PBM_Groups WHERE id=@id', { id: rid });
        return r.rowsAffected[0] ? ok({ deleted: true }) : notFound();
      }
      return badRequest('unknown resource');
    }

    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
