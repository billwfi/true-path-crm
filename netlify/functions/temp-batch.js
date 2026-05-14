const { db } = require('./_db');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id, action } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await db('SELECT * FROM tp_temp_batch WHERE id = $1', [id]);
        return r.rows[0] ? ok(r.rows[0]) : notFound();
      }
      const r = await db("SELECT * FROM tp_temp_batch WHERE status IN ('Pending','Error') ORDER BY created_at DESC");
      return ok(r.rows);
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const records = Array.isArray(body) ? body : [body];
      const batchId = `IMP-${Date.now()}`;
      const ids = [];
      for (const b of records) {
        const r = await db(
          `INSERT INTO tp_temp_batch
           (customer_name,customer_id,drug,vendor,day_supply,price,cost,unit_type,unit_quantity,vendor_quantity,
            unit_price,unit_cost,shipping_method,date_prescribed,num_refills,is_refill,override,import_batch_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
          [b.customer_name||null, b.customer_id||null, b.drug||null, b.vendor||null,
           b.day_supply||null, b.price||null, b.cost||null, b.unit_type||null,
           b.unit_quantity||null, b.vendor_quantity||null, b.unit_price||null, b.unit_cost||null,
           b.shipping_method||null, b.date_prescribed||null, b.num_refills||null,
           b.is_refill ? true : false, b.override ? true : false, batchId]);
        ids.push(r.rows[0].id);
      }
      return created({ ids, import_batch_id: batchId });
    }

    if (event.httpMethod === 'PATCH') {
      if (id) {
        const b = JSON.parse(event.body || '{}');
        await db(
          'UPDATE tp_temp_batch SET status=$1, override=$2, price=$3, cost=$4 WHERE id=$5',
          [b.status||'Pending', b.override ? true : false, b.price||null, b.cost||null, id]);
        return ok({ id });
      }

      if (action === 'approve_all') {
        const b = JSON.parse(event.body || '{}');
        const pending = await db(
          "SELECT * FROM tp_temp_batch WHERE status='Pending'" +
          (b.import_batch_id ? " AND import_batch_id=$1" : ''),
          b.import_batch_id ? [b.import_batch_id] : []);

        const batchIds = [];
        for (const row of pending.rows) {
          const r = await db(
            `INSERT INTO tp_batch
             (customer_id,customer_name,drug_name,vendor,vendor_day_supply,unit_quantity,vendor_quantity,
              unit_price,unit_cost,shipping_method,transaction_date,status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Completed') RETURNING id`,
            [row.customer_id, row.customer_name, row.drug, row.vendor, row.day_supply,
             row.unit_quantity, row.vendor_quantity, row.unit_price, row.unit_cost,
             row.shipping_method, row.date_prescribed]);
          batchIds.push(r.rows[0].id);
          await db("UPDATE tp_temp_batch SET status='Approved' WHERE id=$1", [row.id]);
        }
        return ok({ approved: batchIds.length, batch_ids: batchIds });
      }
      return badRequest('id or action=approve_all required');
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await db('DELETE FROM tp_temp_batch WHERE id = $1', [id]);
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
