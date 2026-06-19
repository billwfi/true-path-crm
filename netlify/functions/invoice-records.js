const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

const WS = 'dbo.wellsync_data_June';
const CDT = `TRY_CONVERT(datetime2, REPLACE(REPLACE(completed_at, 'Z', ''), 'T', ' '))`;

// Generate snapshot line items for an invoice from completed WellSync transactions in the
// billing window, priced by the client's GLP1 benefit rates. Linked by GroupName = client name.
async function generateLines(invId, clientId, clientName, from, to) {
  await mssql(
    `INSERT INTO dbo.tp_invoice_lines (invoice_id, dispensing_date, category, member_id, member_name, units, product_name, amount)
     SELECT @inv,
            TRY_CONVERT(date, ${CDT}) AS dispensing_date,
            CASE WHEN w.service_service_name LIKE '%Follow Up%' THEN 'Refill' ELSE 'Initial Order' END,
            w.memberid, w.patient_fullname, 1, w.medication,
            CAST(CASE w.medication WHEN 'Tirzepatide' THEN r.tirz WHEN 'Semaglutide' THEN r.sema ELSE 0 END AS DECIMAL(18,2))
     FROM ${WS} w
     CROSS JOIN (SELECT MAX(b.tirzepatide_amount) AS tirz, MAX(b.semaglutide_amount) AS sema
                 FROM dbo.Client_Contracts ct
                 JOIN dbo.Client_Contract_Benefits b ON b.contract_id = ct.id
                 WHERE ct.client_id = @cid AND b.type = 'GLP1') r
     WHERE LTRIM(RTRIM(w.GroupName)) = @name AND w.status = 'completed'
       AND ${CDT} >= @from AND ${CDT} < DATEADD(day, 1, @to)
     ORDER BY ${CDT}`,
    { inv: invId, cid: clientId, name: clientName, from, to });
}

async function recomputeTotals(invId) {
  await mssql(
    `UPDATE dbo.tp_invoices
     SET subtotal = ISNULL((SELECT SUM(amount) FROM dbo.tp_invoice_lines WHERE invoice_id = @id), 0),
         amount_due = ISNULL((SELECT SUM(amount) FROM dbo.tp_invoice_lines WHERE invoice_id = @id), 0) + adjustments
     WHERE id = @id`, { id: invId });
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();
  const { id, regenerate } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const h = await mssql(
          `SELECT i.*, c.name AS client_name, c.irx_client_id, c.address, c.city, c.state, c.zip_code
           FROM dbo.tp_invoices i LEFT JOIN dbo.tp_clients c ON c.id = i.client_id
           WHERE i.id = @id`, { id: parseInt(id, 10) });
        if (!h.recordset[0]) return notFound();
        const lines = await mssql(
          `SELECT id, dispensing_date, category, member_id, member_name, units, product_name, amount
           FROM dbo.tp_invoice_lines WHERE invoice_id = @id ORDER BY dispensing_date, id`,
          { id: parseInt(id, 10) });
        return ok({ ...h.recordset[0], lines: lines.recordset });
      }
      const r = await mssql(
        `SELECT i.id, i.invoice_number, i.client_id, c.name AS client_name,
                i.billing_start, i.billing_end, i.invoice_date, i.due_date, i.status,
                i.subtotal, i.adjustments, i.amount_due, i.created_at
         FROM dbo.tp_invoices i LEFT JOIN dbo.tp_clients c ON c.id = i.client_id
         ORDER BY i.invoice_date DESC, i.id DESC`);
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      const cid = parseInt(b.client_id, 10);
      if (!cid) return badRequest('client_id required');
      if (!b.billing_start || !b.billing_end) return badRequest('billing_start and billing_end required');
      const cl = await mssql('SELECT id, name FROM dbo.tp_clients WHERE id=@id', { id: cid });
      const client = cl.recordset[0];
      if (!client) return notFound();

      const invoiceDate = b.invoice_date || new Date().toISOString().slice(0, 10);
      const dueDate = b.due_date || new Date(new Date(invoiceDate).getTime() + 7 * 864e5).toISOString().slice(0, 10);
      const ym = invoiceDate.slice(0, 7).replace('-', '');
      const cnt = await mssql(
        `SELECT COUNT(*) AS n FROM dbo.tp_invoices WHERE invoice_number LIKE @p`, { p: `INV-${ym}-%` });
      const invoiceNumber = `INV-${ym}-${String(cnt.recordset[0].n + 1).padStart(3, '0')}`;

      const ins = await mssql(
        `INSERT INTO dbo.tp_invoices (invoice_number, client_id, billing_start, billing_end, invoice_date, due_date, status, subtotal, adjustments, amount_due)
         VALUES (@num, @cid, @start, @end, @idate, @ddate, 'Open', 0, 0, 0);
         SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
        { num: invoiceNumber, cid, start: b.billing_start, end: b.billing_end, idate: invoiceDate, ddate: dueDate });
      const invId = ins.recordset[0].id;

      await generateLines(invId, cid, client.name, b.billing_start, b.billing_end);
      await recomputeTotals(invId);
      return created({ id: invId, invoice_number: invoiceNumber });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const invId = parseInt(id, 10);
      const b = JSON.parse(event.body || '{}');

      await mssql(
        `UPDATE dbo.tp_invoices
         SET billing_start=@start, billing_end=@end, invoice_date=@idate, due_date=@ddate,
             sent_date=@sdate, status=@status, adjustments=@adj, notes=@notes
         WHERE id=@id`,
        { id: invId, start: b.billing_start || null, end: b.billing_end || null,
          idate: b.invoice_date || null, ddate: b.due_date || null, sdate: b.sent_date || null,
          status: b.status || 'Open', adj: Number(b.adjustments) || 0, notes: b.notes || null });

      if (regenerate === '1') {
        const cl = await mssql(
          `SELECT i.client_id, c.name FROM dbo.tp_invoices i JOIN dbo.tp_clients c ON c.id=i.client_id WHERE i.id=@id`,
          { id: invId });
        const row = cl.recordset[0];
        if (row && b.billing_start && b.billing_end) {
          await mssql('DELETE FROM dbo.tp_invoice_lines WHERE invoice_id=@id', { id: invId });
          await generateLines(invId, row.client_id, row.name, b.billing_start, b.billing_end);
        }
      }
      await recomputeTotals(invId);
      return ok({ id: invId });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      const invId = parseInt(id, 10);
      await mssql('DELETE FROM dbo.tp_invoice_lines WHERE invoice_id=@id', { id: invId });
      await mssql('DELETE FROM dbo.tp_invoices WHERE id=@id', { id: invId });
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
