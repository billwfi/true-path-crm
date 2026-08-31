const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

// Sales leads + their contact log, and lead -> client conversion.
//   GET    ?id=X                          -> one lead
//   GET    [?status&search]               -> lead list
//   GET    ?resource=dashboard            -> sales dashboard aggregates
//   GET    ?resource=contacts&lead_id=X   -> a lead's contact-effort log
//   POST                                  -> create lead
//   POST   ?action=convert&id=X           -> convert lead to a client (+ primary contact)
//   POST   ?resource=contact&lead_id=X    -> log a contact effort
//   PATCH  ?id=X                          -> update lead
//   PATCH  ?resource=contact&id=X         -> update a contact effort
//   DELETE ?id=X  |  ?resource=contact&id=X

const CONTACT_TYPES = ['Email', 'Phone', 'Meeting', 'Other'];

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  const { id, status, search, resource, action, lead_id } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (resource === 'dashboard') return await dashboard();
      if (resource === 'contacts') {
        const lid = parseInt(lead_id, 10);
        if (!lid) return badRequest('lead_id required');
        const r = await mssql(
          `SELECT c.id, c.lead_id, c.contact_type, c.contact_date, c.followup_date, c.notes, c.created_at,
                  CONCAT(u.firstname,' ',u.lastname) AS by_name
           FROM dbo.tp_lead_contacts c LEFT JOIN dbo.Users u ON u.id = c.created_by
           WHERE c.lead_id = @lid ORDER BY c.contact_date DESC, c.id DESC`, { lid });
        return ok(r.recordset);
      }
      if (id) {
        const r = await mssql(
          `SELECT l.*, CONCAT(s.firstname, ' ', s.lastname) AS assigned_name
           FROM tp_leads l LEFT JOIN tp_staff s ON s.id = l.assigned_id WHERE l.id = @id`, { id: parseInt(id, 10) });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const r = await mssql(
        `SELECT l.id,l.name,l.company,l.email,l.phone,l.value,l.status,l.source,l.last_contact,l.tags,l.created_at,
                l.converted_client_id, l.converted_at,
                CONCAT(s.firstname, ' ', s.lastname) AS assigned_name,
                (SELECT COUNT(*) FROM dbo.tp_lead_contacts c WHERE c.lead_id = l.id) AS contact_count,
                (SELECT MIN(c.followup_date) FROM dbo.tp_lead_contacts c
                   WHERE c.lead_id = l.id AND c.followup_date >= CAST(GETDATE() AS date)) AS next_followup
         FROM tp_leads l LEFT JOIN tp_staff s ON s.id = l.assigned_id
         WHERE (@status IS NULL OR l.status = @status)
         AND (@search IS NULL OR l.name LIKE @search OR l.company LIKE @search OR l.email LIKE @search)
         ORDER BY l.created_at DESC`,
        { status: status || null, search: search ? `%${search}%` : null });
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      if (action === 'convert') return await convert(parseInt(id, 10), user);
      if (resource === 'contact') {
        const lid = parseInt(lead_id, 10);
        if (!lid) return badRequest('lead_id required');
        const b = JSON.parse(event.body || '{}');
        const type = CONTACT_TYPES.includes(b.contact_type) ? b.contact_type : 'Other';
        const r = await mssql(
          `INSERT INTO dbo.tp_lead_contacts (lead_id, contact_type, contact_date, followup_date, notes, created_by)
           OUTPUT INSERTED.* VALUES (@lid, @type, @cdate, @fdate, @notes, @by)`,
          { lid, type, cdate: b.contact_date || new Date().toISOString().slice(0, 10),
            fdate: b.followup_date || null, notes: b.notes || null, by: user.id || null });
        // Logging a contact advances a brand-new lead to "Contacted" and stamps last_contact.
        await mssql(
          `UPDATE tp_leads SET last_contact = @cdate,
             status = CASE WHEN status = 'New' THEN 'Contacted' ELSE status END
           WHERE id = @lid`, { lid, cdate: b.contact_date || new Date().toISOString().slice(0, 10) });
        return created(r.recordset[0]);
      }
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
      if (resource === 'contact') {
        const cid = parseInt(id, 10);
        if (!cid) return badRequest('id required');
        const b = JSON.parse(event.body || '{}');
        const type = CONTACT_TYPES.includes(b.contact_type) ? b.contact_type : 'Other';
        const r = await mssql(
          `UPDATE dbo.tp_lead_contacts SET contact_type=@type, contact_date=@cdate, followup_date=@fdate, notes=@notes
           OUTPUT INSERTED.* WHERE id=@id`,
          { id: cid, type, cdate: b.contact_date || null, fdate: b.followup_date || null, notes: b.notes || null });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
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
      if (resource === 'contact') {
        const cid = parseInt(id, 10);
        if (!cid) return badRequest('id required');
        await mssql('DELETE FROM dbo.tp_lead_contacts WHERE id=@id', { id: cid });
        return ok({ deleted: true });
      }
      if (!id) return badRequest('id required');
      await mssql('DELETE FROM dbo.tp_lead_contacts WHERE lead_id=@id', { id: parseInt(id, 10) });
      await mssql('DELETE FROM tp_leads WHERE id=@id', { id: parseInt(id, 10) });
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};

// Convert a lead into a client: create the client (company = client, contact person =
// first Client_Contacts row), then mark the lead Converted and link it.
async function convert(lid, user) {
  if (!lid) return badRequest('id required');
  const lead = (await mssql('SELECT * FROM tp_leads WHERE id=@id', { id: lid })).recordset[0];
  if (!lead) return notFound();
  if (lead.converted_client_id) return ok({ client_id: lead.converted_client_id, already: true });

  const clientName = (lead.company && lead.company.trim()) || lead.name || 'New Client';
  const parts = (lead.name || '').trim().split(/\s+/).filter(Boolean);
  const lastname = parts.length > 1 ? parts[parts.length - 1] : null;
  const firstname = parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] || null);
  const notes = `Converted from lead #${lid}` + (lead.notes ? ` — ${lead.notes}` : '');

  const cli = await mssql(
    `INSERT INTO dbo.tp_clients (name, firstname, lastname, email, phone, notes, active)
     VALUES (@name,@fn,@ln,@email,@phone,@notes,1);
     SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
    { name: clientName, fn: firstname, ln: lastname, email: lead.email || null,
      phone: lead.phone || null, notes });
  const clientId = cli.recordset[0].id;

  // If the lead names both a company and a person, seed the person as the primary contact.
  if (lead.name && lead.company && lead.company.trim()) {
    await mssql(
      `INSERT INTO dbo.Client_Contacts (client_id, name, email, phone, notes, created_by)
       VALUES (@cid, @name, @email, @phone, 'Primary contact (converted from lead)', @by)`,
      { cid: clientId, name: lead.name, email: lead.email || null, phone: lead.phone || null, by: user.id || null });
  }
  await mssql(
    `UPDATE tp_leads SET status='Converted', converted_client_id=@cid, converted_at=GETDATE() WHERE id=@id`,
    { cid: clientId, id: lid });
  return ok({ client_id: clientId });
}

async function dashboard() {
  const [byStatus, bySource, byMonth, recent, followups, totals] = await Promise.all([
    mssql(`SELECT status, COUNT(*) n, SUM(TRY_CONVERT(decimal(18,2), value)) val FROM tp_leads GROUP BY status`),
    mssql(`SELECT ISNULL(NULLIF(LTRIM(RTRIM(source)),''),'Unknown') source, COUNT(*) n FROM tp_leads GROUP BY ISNULL(NULLIF(LTRIM(RTRIM(source)),''),'Unknown') ORDER BY n DESC`),
    mssql(`SELECT CONVERT(varchar(7), created_at, 120) ym, COUNT(*) n,
                  SUM(CASE WHEN status='Converted' THEN 1 ELSE 0 END) won
           FROM tp_leads GROUP BY CONVERT(varchar(7), created_at, 120) ORDER BY ym`),
    mssql(`SELECT TOP 8 id, name, company, value, converted_client_id, converted_at
           FROM tp_leads WHERE status='Converted' AND converted_at IS NOT NULL ORDER BY converted_at DESC`),
    mssql(`SELECT TOP 12 c.id, c.lead_id, c.contact_type, c.followup_date, c.notes,
                  l.name AS lead_name, l.company
           FROM dbo.tp_lead_contacts c JOIN tp_leads l ON l.id = c.lead_id
           WHERE c.followup_date >= CAST(GETDATE() AS date) AND l.status NOT IN ('Converted','Lost')
           ORDER BY c.followup_date ASC`),
    mssql(`SELECT COUNT(*) total,
                  SUM(CASE WHEN status='Converted' THEN 1 ELSE 0 END) converted,
                  SUM(CASE WHEN status='Lost' THEN 1 ELSE 0 END) lost,
                  SUM(CASE WHEN status NOT IN ('Converted','Lost') THEN 1 ELSE 0 END) open_leads,
                  SUM(CASE WHEN status NOT IN ('Converted','Lost') THEN TRY_CONVERT(decimal(18,2), value) ELSE 0 END) open_value,
                  SUM(CASE WHEN status='Converted' THEN TRY_CONVERT(decimal(18,2), value) ELSE 0 END) won_value
           FROM tp_leads`),
  ]);
  return ok({
    byStatus: byStatus.recordset, bySource: bySource.recordset, byMonth: byMonth.recordset,
    recent: recent.recordset, followups: followups.recordset, totals: totals.recordset[0],
  });
}
