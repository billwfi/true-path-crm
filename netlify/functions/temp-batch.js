const { getPool, sql } = require('./_db');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const params = event.queryStringParameters || {};
  const { id, action, import_batch_id } = params;

  try {
    const pool = await getPool();

    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await pool.request().input('id', sql.Int, id)
          .query('SELECT * FROM tp_temp_batch WHERE id = @id');
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const r = await pool.request().query(
        "SELECT * FROM tp_temp_batch WHERE status IN ('Pending','Error') ORDER BY created_at DESC");
      return ok(r.recordset);
    }

    // POST — bulk import from CSV (array of rows)
    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const records = Array.isArray(body) ? body : [body];
      const batchId = import_batch_id || `IMP-${Date.now()}`;
      const ids = [];

      for (const b of records) {
        const r = await pool.request()
          .input('customer_name',   sql.NVarChar, b.customer_name    || null)
          .input('customer_id',     sql.NVarChar, b.customer_id      || null)
          .input('drug',            sql.NVarChar, b.drug             || null)
          .input('vendor',          sql.NVarChar, b.vendor           || null)
          .input('day_supply',      sql.Int,      b.day_supply       || null)
          .input('price',           sql.Decimal,  b.price            || null)
          .input('cost',            sql.Decimal,  b.cost             || null)
          .input('unit_type',       sql.NVarChar, b.unit_type        || null)
          .input('unit_qty',        sql.Decimal,  b.unit_quantity    || null)
          .input('vendor_qty',      sql.Decimal,  b.vendor_quantity  || null)
          .input('unit_price',      sql.Decimal,  b.unit_price       || null)
          .input('unit_cost',       sql.Decimal,  b.unit_cost        || null)
          .input('shipping',        sql.NVarChar, b.shipping_method  || null)
          .input('date_prescribed', sql.Date,     b.date_prescribed  || null)
          .input('num_refills',     sql.Int,      b.num_refills      || null)
          .input('is_refill',       sql.Bit,      b.is_refill ? 1 : 0)
          .input('override',        sql.Bit,      b.override ? 1 : 0)
          .input('batch_id',        sql.NVarChar, batchId)
          .query(`INSERT INTO tp_temp_batch
            (customer_name,customer_id,drug,vendor,day_supply,price,cost,unit_type,unit_quantity,vendor_quantity,
             unit_price,unit_cost,shipping_method,date_prescribed,num_refills,is_refill,override,import_batch_id)
            OUTPUT INSERTED.id
            VALUES (@customer_name,@customer_id,@drug,@vendor,@day_supply,@price,@cost,@unit_type,@unit_qty,@vendor_qty,
            @unit_price,@unit_cost,@shipping,@date_prescribed,@num_refills,@is_refill,@override,@batch_id)`);
        ids.push(r.recordset[0].id);
      }
      return created({ ids, import_batch_id: batchId });
    }

    // PATCH — update override, status, or approve single row
    if (event.httpMethod === 'PATCH') {
      if (id) {
        const b = JSON.parse(event.body || '{}');
        await pool.request()
          .input('id',       sql.Int, id)
          .input('status',   sql.NVarChar, b.status || 'Pending')
          .input('override', sql.Bit, b.override ? 1 : 0)
          .input('price',    sql.Decimal, b.price  || null)
          .input('cost',     sql.Decimal, b.cost   || null)
          .query('UPDATE tp_temp_batch SET status=@status,override=@override,price=@price,cost=@cost WHERE id=@id');
        return ok({ id });
      }

      // Approve all pending → move to batch
      if (action === 'approve_all') {
        const bId = JSON.parse(event.body || '{}').import_batch_id;
        const req = pool.request();
        if (bId) req.input('batch_id', sql.NVarChar, bId);
        const rows = await req.query(
          `SELECT * FROM tp_temp_batch WHERE status='Pending'${bId ? ' AND import_batch_id=@batch_id' : ''}`
        );
        const inserted = [];
        for (const row of rows.recordset) {
          const r2 = await pool.request()
            .input('customer_id',   sql.NVarChar, row.customer_id)
            .input('customer_name', sql.NVarChar, row.customer_name)
            .input('drug_name',     sql.NVarChar, row.drug)
            .input('vendor',        sql.NVarChar, row.vendor)
            .input('day_supply',    sql.Int,      row.day_supply)
            .input('unit_qty',      sql.Decimal,  row.unit_quantity)
            .input('vendor_qty',    sql.Decimal,  row.vendor_quantity)
            .input('unit_price',    sql.Decimal,  row.unit_price)
            .input('unit_cost',     sql.Decimal,  row.unit_cost)
            .input('shipping',      sql.NVarChar, row.shipping_method)
            .input('trans_date',    sql.Date,     row.date_prescribed)
            .input('num_refills',   sql.Int,      row.num_refills)
            .query(`INSERT INTO tp_batch (customer_id,customer_name,drug_name,vendor,vendor_day_supply,unit_quantity,
                    vendor_quantity,unit_price,unit_cost,shipping_method,transaction_date,status)
                    OUTPUT INSERTED.id
                    VALUES (@customer_id,@customer_name,@drug_name,@vendor,@day_supply,@unit_qty,@vendor_qty,
                    @unit_price,@unit_cost,@shipping,@trans_date,'Completed')`);
          inserted.push(r2.recordset[0].id);
          await pool.request().input('id', sql.Int, row.id)
            .query("UPDATE tp_temp_batch SET status='Approved' WHERE id=@id");
        }
        return ok({ approved: inserted.length, batch_ids: inserted });
      }
      return badRequest('id or action=approve_all required');
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await pool.request().input('id', sql.Int, id)
        .query('DELETE FROM tp_temp_batch WHERE id=@id');
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
