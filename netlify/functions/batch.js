const { getPool, sql } = require('./_db');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id } = event.queryStringParameters || {};

  try {
    const pool = await getPool();

    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await pool.request().input('id', sql.Int, id)
          .query('SELECT * FROM tp_batch WHERE id = @id');
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const req = pool.request();
      const search = (event.queryStringParameters?.search || '').trim();
      const status = event.queryStringParameters?.status || '';
      let where = 'WHERE 1=1';
      if (status) { req.input('status', sql.NVarChar, status); where += ' AND status = @status'; }
      if (search) {
        req.input('search', sql.NVarChar, `%${search}%`);
        where += ' AND (customer_name LIKE @search OR drug_name LIKE @search OR customer_id LIKE @search OR transaction_id LIKE @search)';
      }
      const r = await req.query(
        `SELECT id,customer_id,transaction_id,customer_name,drug_name,vendor,strength,
         unit_quantity,vendor_quantity,transaction_price,transaction_cost,shipping_method,
         status,transaction_date,document_patient_id,vendor_day_supply,created_at
         FROM tp_batch ${where} ORDER BY created_at DESC`);
      return ok(r.recordset);
    }

    // POST — single record or bulk array
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const records = Array.isArray(body) ? body : [body];
      const ids = [];
      for (const b of records) {
        const r = await pool.request()
          .input('customer_id',    sql.NVarChar, b.customer_id         || null)
          .input('transaction_id', sql.NVarChar, b.transaction_id      || null)
          .input('customer_name',  sql.NVarChar, b.customer_name       || null)
          .input('drug_name',      sql.NVarChar, b.drug_name           || null)
          .input('vendor',         sql.NVarChar, b.vendor              || null)
          .input('strength',       sql.NVarChar, b.strength            || null)
          .input('unit_qty',       sql.Decimal,  b.unit_quantity       || null)
          .input('vendor_qty',     sql.Decimal,  b.vendor_quantity     || null)
          .input('unit_price',     sql.Decimal,  b.unit_price          || null)
          .input('unit_cost',      sql.Decimal,  b.unit_cost           || null)
          .input('trans_price',    sql.Decimal,  b.transaction_price   || null)
          .input('trans_cost',     sql.Decimal,  b.transaction_cost    || null)
          .input('shipping',       sql.NVarChar, b.shipping_method     || null)
          .input('status',         sql.NVarChar, b.status || 'Pending')
          .input('trans_date',     sql.Date,     b.transaction_date    || null)
          .input('doc_patient_id', sql.NVarChar, b.document_patient_id || null)
          .input('day_supply',     sql.Int,      b.vendor_day_supply   || null)
          .input('order_id',       sql.NVarChar, b.order_id            || null)
          .query(`INSERT INTO tp_batch
            (customer_id,transaction_id,customer_name,drug_name,vendor,strength,unit_quantity,vendor_quantity,
             unit_price,unit_cost,transaction_price,transaction_cost,shipping_method,status,transaction_date,
             document_patient_id,vendor_day_supply,order_id)
            OUTPUT INSERTED.id
            VALUES (@customer_id,@transaction_id,@customer_name,@drug_name,@vendor,@strength,@unit_qty,@vendor_qty,
            @unit_price,@unit_cost,@trans_price,@trans_cost,@shipping,@status,@trans_date,@doc_patient_id,@day_supply,@order_id)`);
        ids.push(r.recordset[0].id);
      }
      return created({ ids });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await pool.request()
        .input('id',     sql.Int, id)
        .input('status', sql.NVarChar, b.status)
        .input('error',  sql.NVarChar, b.error_message || null)
        .query('UPDATE tp_batch SET status=@status,error_message=@error WHERE id=@id');
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await pool.request().input('id', sql.Int, id).query('DELETE FROM tp_batch WHERE id=@id');
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
