const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id, status, search } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await mssql('SELECT * FROM tp_batch WHERE id = @id', { id: parseInt(id, 10) });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const r = await mssql(
        `SELECT id,customer_id,transaction_id,customer_name,drug_name,vendor,strength,
         unit_quantity,vendor_quantity,transaction_price,transaction_cost,shipping_method,
         status,transaction_date,document_patient_id,vendor_day_supply,created_at
         FROM tp_batch
         WHERE (@status IS NULL OR status = @status)
         AND (@search IS NULL OR customer_name LIKE @search OR drug_name LIKE @search
              OR customer_id LIKE @search OR transaction_id LIKE @search)
         ORDER BY created_at DESC`,
        { status: status || null, search: search ? `%${search}%` : null });
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const records = Array.isArray(body) ? body : [body];
      const ids = [];
      for (const b of records) {
        const r = await mssql(
          `INSERT INTO tp_batch
           (customer_id,transaction_id,customer_name,drug_name,vendor,strength,unit_quantity,vendor_quantity,
            unit_price,unit_cost,transaction_price,transaction_cost,shipping_method,status,transaction_date,
            document_patient_id,vendor_day_supply,order_id)
           VALUES (@customer_id,@transaction_id,@customer_name,@drug_name,@vendor,@strength,@unit_quantity,@vendor_quantity,
            @unit_price,@unit_cost,@transaction_price,@transaction_cost,@shipping_method,@status,@transaction_date,
            @document_patient_id,@vendor_day_supply,@order_id);
           SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
          { customer_id: b.customer_id || null, transaction_id: b.transaction_id || null, customer_name: b.customer_name || null,
            drug_name: b.drug_name || null, vendor: b.vendor || null, strength: b.strength || null,
            unit_quantity: b.unit_quantity || null, vendor_quantity: b.vendor_quantity || null,
            unit_price: b.unit_price || null, unit_cost: b.unit_cost || null, transaction_price: b.transaction_price || null,
            transaction_cost: b.transaction_cost || null, shipping_method: b.shipping_method || null,
            status: b.status || 'Pending', transaction_date: b.transaction_date || null,
            document_patient_id: b.document_patient_id || null, vendor_day_supply: b.vendor_day_supply || null,
            order_id: b.order_id || null });
        ids.push(r.recordset[0].id);
      }
      return created({ ids });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await mssql('UPDATE tp_batch SET status=@status, error_message=@error_message WHERE id=@id',
        { status: b.status, error_message: b.error_message || null, id: parseInt(id, 10) });
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await mssql('DELETE FROM tp_batch WHERE id = @id', { id: parseInt(id, 10) });
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
