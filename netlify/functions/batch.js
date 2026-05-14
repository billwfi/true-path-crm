const { db } = require('./_db');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  const { id, status, search } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (id) {
        const r = await db('SELECT * FROM tp_batch WHERE id = $1', [id]);
        return r.rows[0] ? ok(r.rows[0]) : notFound();
      }
      const r = await db(
        `SELECT id,customer_id,transaction_id,customer_name,drug_name,vendor,strength,
         unit_quantity,vendor_quantity,transaction_price,transaction_cost,shipping_method,
         status,transaction_date,document_patient_id,vendor_day_supply,created_at
         FROM tp_batch
         WHERE ($1::text IS NULL OR status = $1)
         AND ($2::text IS NULL OR customer_name ILIKE $2 OR drug_name ILIKE $2
              OR customer_id ILIKE $2 OR transaction_id ILIKE $2)
         ORDER BY created_at DESC`,
        [status || null, search ? `%${search}%` : null]);
      return ok(r.rows);
    }

    if (event.httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const records = Array.isArray(body) ? body : [body];
      const ids = [];
      for (const b of records) {
        const r = await db(
          `INSERT INTO tp_batch
           (customer_id,transaction_id,customer_name,drug_name,vendor,strength,unit_quantity,vendor_quantity,
            unit_price,unit_cost,transaction_price,transaction_cost,shipping_method,status,transaction_date,
            document_patient_id,vendor_day_supply,order_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
          [b.customer_id||null, b.transaction_id||null, b.customer_name||null, b.drug_name||null,
           b.vendor||null, b.strength||null, b.unit_quantity||null, b.vendor_quantity||null,
           b.unit_price||null, b.unit_cost||null, b.transaction_price||null, b.transaction_cost||null,
           b.shipping_method||null, b.status||'Pending', b.transaction_date||null,
           b.document_patient_id||null, b.vendor_day_supply||null, b.order_id||null]);
        ids.push(r.rows[0].id);
      }
      return created({ ids });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      await db('UPDATE tp_batch SET status=$1, error_message=$2 WHERE id=$3',
        [b.status, b.error_message||null, id]);
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      await db('DELETE FROM tp_batch WHERE id = $1', [id]);
      return ok({ deleted: true });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
