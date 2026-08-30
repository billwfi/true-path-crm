const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, badRequest, notFound, serverError, options } = require('./_auth');

// Members — profiles + medication history migrated from Unifeyed
// (dbo.tp_uf_members / dbo.tp_member_medications).
//   GET ?resource=summary                     -> { members, active_members, meds }
//   GET ?resource=companies                    -> companies that have members (+ counts)
//   GET ?id=<member_source_id>                 -> member profile + medication history
//   GET [&search&company_id&active]            -> members (TOP 500)

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();
  const { id, resource, search, company_id, active } = event.queryStringParameters || {};

  try {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    if (resource === 'summary') {
      const r = (await mssql(
        `SELECT (SELECT COUNT(*) FROM dbo.tp_uf_members) members,
                (SELECT COUNT(*) FROM dbo.tp_uf_members WHERE active=1) active_members,
                (SELECT COUNT(*) FROM dbo.tp_member_medications) meds`)).recordset[0];
      return ok(r);
    }

    if (resource === 'companies') {
      const r = (await mssql(
        `SELECT c.company_id, c.name,
                (SELECT COUNT(*) FROM dbo.tp_uf_members m WHERE m.uf_company_id=c.company_id) members
         FROM dbo.tp_uf_companies c
         WHERE EXISTS (SELECT 1 FROM dbo.tp_uf_members m WHERE m.uf_company_id=c.company_id)
         ORDER BY c.name`)).recordset;
      return ok(r);
    }

    if (id) {
      const m = (await mssql(
        `SELECT m.*, c.name AS company FROM dbo.tp_uf_members m
         LEFT JOIN dbo.tp_uf_companies c ON c.company_id=m.uf_company_id
         WHERE m.member_source_id=@id`, { id: parseInt(id, 10) })).recordset[0];
      if (!m) return notFound();
      m.medications = (await mssql(
        `SELECT md.id, md.product_source_id, md.strength, md.day_supply, md.number_of_refills,
                md.next_fill_order_date, md.ndc_code, md.reporting_unit, md.reporting_qty, md.inactive,
                p.short_name, p.label, p.strength AS product_strength, p.ndc_comp, p.unit_type
         FROM dbo.tp_member_medications md
         LEFT JOIN dbo.tp_products p ON p.source_id=md.product_source_id
         WHERE md.member_source_id=@id ORDER BY md.inactive, p.short_name`, { id: parseInt(id, 10) })).recordset;
      return ok(m);
    }

    const r = (await mssql(
      `SELECT TOP 500 m.member_source_id, m.first_name, m.last_name, m.date_of_birth, m.gender,
              m.member_id, m.cardholder_id, m.group_id, m.enrollment_status, m.active, c.name AS company,
              (SELECT COUNT(*) FROM dbo.tp_member_medications md WHERE md.member_source_id=m.member_source_id) meds
       FROM dbo.tp_uf_members m
       LEFT JOIN dbo.tp_uf_companies c ON c.company_id=m.uf_company_id
       WHERE (@co IS NULL OR m.uf_company_id=@co)
         AND (@act IS NULL OR m.active=@act)
         AND (@s IS NULL OR m.last_name LIKE @s OR m.first_name LIKE @s OR m.member_id LIKE @s OR m.cardholder_id LIKE @s)
       ORDER BY m.last_name, m.first_name`,
      { co: company_id ? parseInt(company_id, 10) : null,
        act: (active === '0' || active === '1') ? parseInt(active, 10) : null,
        s: search ? `%${search}%` : null })).recordset;
    return ok(r);
  } catch (err) {
    return serverError(err);
  }
};
