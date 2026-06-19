const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id, action } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await mssql('SELECT * FROM tp_temp_batch WHERE id = @id', { id: parseInt(id, 10) });
        return r.recordset[0] ? ok(r.recordset[0]) : notFound();
      }
      const r = await mssql("SELECT * FROM tp_temp_batch WHERE status IN ('Pending','Error') ORDER BY created_at DESC");
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const records = Array.isArray(body) ? body : [body];
      const batchId = `IMP-${Date.now()}`;
      const ids = [];
      for (const b of records) {
        const r = await mssql(
          `INSERT INTO tp_temp_batch
           (customer_name,customer_id,drug,vendor,day_supply,price,cost,unit_type,unit_quantity,vendor_quantity,
            unit_price,unit_cost,shipping_method,date_prescribed,num_refills,is_refill,override,import_batch_id)
           VALUES (@customer_name,@customer_id,@drug,@vendor,@day_supply,@price,@cost,@unit_type,@unit_quantity,@vendor_quantity,
            @unit_price,@unit_cost,@shipping_method,@date_prescribed,@num_refills,@is_refill,@override,@import_batch_id);
           SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
          { customer_name: b.customer_name || null, customer_id: b.customer_id || null, drug: b.drug || null,
            vendor: b.vendor || null, day_supply: b.day_supply || null, price: b.price || null, cost: b.cost || null,
            unit_type: b.unit_type || null, unit_quantity: b.unit_quantity || null, vendor_quantity: b.vendor_quantity || null,
            unit_price: b.unit_price || null, unit_cost: b.unit_cost || null, shipping_method: b.shipping_method || null,
            date_prescribed: b.date_prescribed || null, num_refills: b.num_refills || null,
            is_refill: b.is_refill ? 1 : 0, override: b.override ? 1 : 0, import_batch_id: batchId });
        ids.push(r.recordset[0].id);
      }
      return created({ ids, import_batch_id: batchId });
    }

    if (event.httpMethod === 'PATCH') {
      if (id) {
        const b = JSON.parse(event.body || '{}');
        await mssql(
          'UPDATE tp_temp_batch SET status=@status, override=@override, price=@price, cost=@cost WHERE id=@id',
          { status: b.status || 'Pending', override: b.override ? 1 : 0, price: b.price || null,
            cost: b.cost || null, id: parseInt(id, 10) });
        return ok({ id });
      }

      if (action === 'approve_all') {
        const b = JSON.parse(event.body || '{}');
        const pending = await mssql(
          "SELECT * FROM tp_temp_batch WHERE status='Pending'" +
          (b.import_batch_id ? ' AND import_batch_id=@import_batch_id' : ''),
          b.import_batch_id ? { import_batch_id: b.import_batch_id } : {});

        const batchIds = [];
        for (const row of pending.recordset) {
          const r = await mssql(
            `INSERT INTO tp_batch
             (customer_id,customer_name,drug_name,vendor,vendor_day_supply,unit_quantity,vendor_quantity,
              unit_price,unit_cost,shipping_method,transaction_date,status)
             VALUES (@customer_id,@customer_name,@drug,@vendor,@day_supply,@unit_quantity,@vendor_quantity,
              @unit_price,@unit_cost,@shipping_method,@date_prescribed,'Completed');
             SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`,
            { customer_id: row.customer_id, customer_name: row.customer_name, drug: row.drug, vendor: row.vendor,
              day_supply: row.day_supply, unit_quantity: row.unit_quantity, vendor_quantity: row.vendor_quantity,
              unit_price: row.unit_price, unit_cost: row.unit_cost, shipping_method: row.shipping_method,
              date_prescribed: row.date_prescribed });
          batchIds.push(r.recordset[0].id);
          await mssql("UPDATE tp_temp_batch SET status='Approved' WHERE id=@id", { id: row.id });
        }
        return ok({ approved: batchIds.length, batch_ids: batchIds });
      }
      return badRequest('id or action=approve_all required');
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await mssql('DELETE FROM tp_temp_batch WHERE id = @id', { id: parseInt(id, 10) });
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
