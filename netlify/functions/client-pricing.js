const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, badRequest, serverError, options } = require('./_auth');

// Procurement › Client Pricing, Rebates & Formulary.
//   GET  ?resource=companies                         -> companies with pricing/formulary + counts
//   GET  ?resource=pricing&company_id=X              -> pricing rows (joined to product master)
//   GET  ?resource=formulary&company_id=X[&search=Y] -> { count } or matched approved products
//   PATCH ?id=  (pricing row)                         -> update price / rebate_amount / max_annual_rebate

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();
  const { resource, id, company_id, search } = event.queryStringParameters || {};
  const cid = company_id ? parseInt(company_id, 10) : null;

  try {
    if (event.httpMethod === 'GET') {
      if (resource === 'companies') {
        const r = (await mssql(
          `SELECT c.company_id, c.name, c.status,
                  (SELECT COUNT(*) FROM dbo.tp_client_pricing p WHERE p.company_id=c.company_id) pricing,
                  ISNULL((SELECT product_count FROM dbo.tp_client_formulary f WHERE f.company_id=c.company_id),0) formulary
           FROM dbo.tp_uf_companies c
           WHERE EXISTS (SELECT 1 FROM dbo.tp_client_pricing p WHERE p.company_id=c.company_id)
              OR EXISTS (SELECT 1 FROM dbo.tp_client_formulary f WHERE f.company_id=c.company_id)
           ORDER BY c.name`)).recordset;
        return ok(r);
      }
      if (resource === 'pricing') {
        if (!cid) return badRequest('company_id required');
        const r = (await mssql(
          `SELECT pr.id, pr.product_source_id, p.short_name, p.label, p.strength, p.ndc_comp,
                  pr.price, pr.rebate_amount, pr.max_annual_rebate, pr.company_unit_price
           FROM dbo.tp_client_pricing pr
           LEFT JOIN dbo.tp_products p ON p.source_id=pr.product_source_id
           WHERE pr.company_id=@cid ORDER BY p.short_name, p.strength`, { cid })).recordset;
        return ok(r);
      }
      if (resource === 'formulary') {
        if (!cid) return badRequest('company_id required');
        const cnt = (await mssql(
          `SELECT ISNULL(product_count,0) n FROM dbo.tp_client_formulary WHERE company_id=@cid`, { cid })).recordset[0];
        const count = cnt ? cnt.n : 0;
        // list this company's approved products (TOP 500), optionally narrowed by search
        const r = (await mssql(
          `SELECT TOP 500 p.source_id, p.short_name, p.label, p.strength, p.ndc_comp, p.unit_type
           FROM dbo.tp_client_formulary f
           CROSS APPLY OPENJSON(f.products_json) j
           JOIN dbo.tp_products p ON p.source_id = TRY_CONVERT(int, j.value)
           WHERE f.company_id=@cid
             AND (@s IS NULL OR p.short_name LIKE @s OR p.label LIKE @s OR p.ndc_comp LIKE @s)
           ORDER BY p.short_name, p.strength`,
          { cid, s: search ? `%${search}%` : null })).recordset;
        return ok({ count, products: r });
      }
      return badRequest('resource required');
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      const num = (v) => (v === '' || v === null || v === undefined || isNaN(parseFloat(v))) ? null : parseFloat(v);
      await mssql(
        `UPDATE dbo.tp_client_pricing
           SET price=COALESCE(@price,price), rebate_amount=COALESCE(@ra,rebate_amount),
               max_annual_rebate=COALESCE(@mar,max_annual_rebate)
         WHERE id=@id`,
        { price: num(b.price), ra: num(b.rebate_amount), mar: num(b.max_annual_rebate), id: parseInt(id, 10) });
      return ok({ id });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};
