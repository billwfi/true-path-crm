const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options } = require('./_auth');

// Procurement › Product Master & Vendors (dbo.tp_products / dbo.tp_vendors).
//   GET  ?resource=summary                 -> { products, with_ndc, vendors }
//   GET  ?resource=vendors                 -> vendors (+ product counts)
//   GET  ?id=                              -> one product (+ alt NDCs)
//   GET  [&search&vendor_id&active]        -> products (TOP 500)
//   POST ?resource=vendor | POST           -> create vendor | product
//   PATCH ?resource=vendor&id | PATCH ?id  -> update
//   DELETE ?resource=vendor&id | DELETE ?id

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();
  const { id, resource, search, vendor_id, active } = event.queryStringParameters || {};
  const isVendor = resource === 'vendor' || resource === 'vendors';

  try {
    if (event.httpMethod === 'GET') {
      if (resource === 'summary') {
        const r = (await mssql(
          `SELECT (SELECT COUNT(*) FROM dbo.tp_products) products,
                  (SELECT COUNT(*) FROM dbo.tp_products WHERE NULLIF(ndc,'') IS NOT NULL) with_ndc,
                  (SELECT COUNT(*) FROM dbo.tp_vendors) vendors`)).recordset[0];
        return ok(r);
      }
      if (resource === 'vendors') {
        const r = (await mssql(
          `SELECT v.id, v.name, v.active,
                  (SELECT COUNT(*) FROM dbo.tp_products p WHERE p.vendor_id=v.id) products
           FROM dbo.tp_vendors v ORDER BY v.name`)).recordset;
        return ok(r);
      }
      if (id) {
        const p = (await mssql(
          `SELECT p.*, v.name AS vendor FROM dbo.tp_products p
           LEFT JOIN dbo.tp_vendors v ON v.id=p.vendor_id WHERE p.id=@id`, { id: parseInt(id, 10) })).recordset[0];
        if (!p) return notFound();
        p.alt_ndc = (await mssql(
          `SELECT ndc_code FROM dbo.tp_product_ndc WHERE product_source_id=@sid`, { sid: p.source_id })).recordset.map(x => x.ndc_code);
        return ok(p);
      }
      const r = (await mssql(
        `SELECT TOP 500 p.id, p.source_id, p.short_name, p.label, p.strength, p.ndc, p.ndc_comp,
                p.unit_type, p.unit_quantity, p.unit_price, p.unit_cost, p.price, p.awp,
                p.vendor_id, v.name AS vendor, p.specialty, p.high_maintenance, p.active, p.source_status
         FROM dbo.tp_products p LEFT JOIN dbo.tp_vendors v ON v.id=p.vendor_id
         WHERE (@vid IS NULL OR p.vendor_id=@vid)
           AND (@act IS NULL OR p.active=@act)
           AND (@s IS NULL OR p.short_name LIKE @s OR p.label LIKE @s OR p.ndc LIKE @s OR p.ndc_comp LIKE @s OR p.strength LIKE @s)
         ORDER BY p.short_name, p.strength`,
        { vid: vendor_id ? parseInt(vendor_id, 10) : null,
          act: (active === '0' || active === '1') ? parseInt(active, 10) : null,
          s: search ? `%${search}%` : null })).recordset;
      return ok(r);
    }

    if (event.httpMethod === 'POST') {
      const b = JSON.parse(event.body || '{}');
      if (isVendor) {
        if (!b.id || !b.name) return badRequest('id and name required');
        await mssql(
          `IF EXISTS (SELECT 1 FROM dbo.tp_vendors WHERE id=@id)
             UPDATE dbo.tp_vendors SET name=@name, active=@act WHERE id=@id
           ELSE INSERT INTO dbo.tp_vendors (id,name,active) VALUES (@id,@name,@act)`,
          { id: parseInt(b.id, 10), name: b.name, act: b.active === false ? 0 : 1 });
        return created({ id: parseInt(b.id, 10) });
      }
      if (!b.short_name && !b.label) return badRequest('short_name or label required');
      const r = await mssql(
        `INSERT INTO dbo.tp_products (short_name,label,strength,ndc,ndc_comp,unit_type,unit_quantity,
           unit_price,unit_cost,price,awp,vendor_id,specialty,high_maintenance,active)
         VALUES (@sn,@label,@str,@ndc,@ndcc,@ut,@uq,@up,@uc,@price,@awp,@vid,@sp,@hm,@act);
         SELECT CAST(SCOPE_IDENTITY() AS INT) id;`, pparams(b));
      return created({ id: r.recordset[0].id });
    }

    if (event.httpMethod === 'PATCH') {
      if (!id) return badRequest('id required');
      const b = JSON.parse(event.body || '{}');
      if (isVendor) {
        await mssql('UPDATE dbo.tp_vendors SET name=COALESCE(@name,name), active=COALESCE(@act,active) WHERE id=@id',
          { name: b.name || null, act: (b.active === true ? 1 : b.active === false ? 0 : null), id: parseInt(id, 10) });
        return ok({ id });
      }
      const p = pparams(b); p.id = parseInt(id, 10);
      await mssql(
        `UPDATE dbo.tp_products SET short_name=@sn, label=@label, strength=@str, ndc=@ndc, ndc_comp=@ndcc,
           unit_type=@ut, unit_quantity=@uq, unit_price=@up, unit_cost=@uc, price=@price, awp=@awp,
           vendor_id=@vid, specialty=@sp, high_maintenance=@hm, active=@act, updated_at=SYSUTCDATETIME()
         WHERE id=@id`, p);
      return ok({ id });
    }

    if (event.httpMethod === 'DELETE') {
      if (!id) return badRequest('id required');
      if (isVendor) { await mssql('DELETE FROM dbo.tp_vendors WHERE id=@id', { id: parseInt(id, 10) }); return ok({ id }); }
      await mssql('DELETE FROM dbo.tp_products WHERE id=@id', { id: parseInt(id, 10) });
      return ok({ id });
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};

function num(v) { return (v === '' || v === null || v === undefined) ? null : (isNaN(parseFloat(v)) ? null : parseFloat(v)); }
function pparams(b) {
  return {
    sn: b.short_name || null, label: b.label || null, str: b.strength || null,
    ndc: b.ndc || null, ndcc: b.ndc_comp || null, ut: b.unit_type || null,
    uq: num(b.unit_quantity), up: num(b.unit_price), uc: num(b.unit_cost),
    price: num(b.price), awp: num(b.awp), vid: b.vendor_id ? parseInt(b.vendor_id, 10) : null,
    sp: b.specialty ? 1 : 0, hm: b.high_maintenance ? 1 : 0,
    act: (b.active === false || b.active === 0) ? 0 : 1,
  };
}
