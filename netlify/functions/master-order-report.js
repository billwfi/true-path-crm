const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, badRequest, serverError, options } = require('./_auth');

// Master Order Report — reproduces the old-CRM per-order billing report over the
// Unifeyed source (Unifeyed.dbo.tbltransactions + tblclients + tblproducts + companies/brokers),
// for a Friday–Thursday (or any) date range. Read-only, cross-database on the same server.
//   GET ?from=&to=[&company=&broker=&status=&search=]  -> { rows, total } (35-column detail)
//   GET ?rollup=1&from=&to=[...]                        -> per-company weekly totals
//   GET ?latest=1                                       -> { latest } max order date (for defaults)
//   GET ?resource=filters&from=&to=                     -> { companies, brokers, statuses } for dropdowns

const DETAIL_MAX = 10000;

// date_ordered is US m/d/yyyy text; parse to a real DATE for filtering/sorting.
const D = `TRY_CONVERT(date, t.date_ordered, 101)`;
const JOINS = `
  FROM Unifeyed.dbo.tbltransactions t
  JOIN Unifeyed.dbo.tblclients c ON c.userid = t.customer_id
  LEFT JOIN Unifeyed.dbo.tblmedications m ON m.id = t.medication_id
  LEFT JOIN Unifeyed.dbo.tblproducts pr  ON pr.id  = TRY_CONVERT(int, m.drug)
  LEFT JOIN Unifeyed.dbo.tblproducts prd ON prd.id = TRY_CONVERT(int, t.drug)
  LEFT JOIN Unifeyed.dbo.tblcompanies co ON co.id = c.company_id
  LEFT JOIN Unifeyed.dbo.tblbrokers b ON b.id = co.broker`;

function whereClause(q) {
  const conds = [`${D} BETWEEN @from AND @to`];
  const params = { from: q.from, to: q.to };
  if (q.company) { conds.push('c.company_id = @company'); params.company = q.company; }
  if (q.broker)  { conds.push('b.id_number = @broker');   params.broker = q.broker; }
  if (q.status)  { conds.push('t.order_status = @status'); params.status = q.status; }
  if (q.search)  { conds.push('(c.first_name LIKE @search OR c.last_name LIKE @search OR t.order_number LIKE @search OR COALESCE(pr.label, prd.label) LIKE @search)'); params.search = `%${q.search}%`; }
  return { where: conds.join(' AND '), params };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  const q = event.queryStringParameters || {};
  try {
    if (q.latest) {
      const r = await mssql(`SELECT MAX(TRY_CONVERT(date, date_ordered, 101)) AS latest FROM Unifeyed.dbo.tbltransactions`);
      return ok({ latest: r.recordset[0] && r.recordset[0].latest });
    }

    if (q.resource === 'filters') {
      if (!q.from || !q.to) return badRequest('from and to required');
      const { where, params } = whereClause({ from: q.from, to: q.to });
      const [companies, brokers, statuses] = await Promise.all([
        mssql(`SELECT DISTINCT c.company_id AS id, c.company AS name ${JOINS} WHERE ${where} AND c.company IS NOT NULL ORDER BY c.company`, params),
        mssql(`SELECT DISTINCT b.id_number AS id, b.name ${JOINS} WHERE ${where} AND b.id_number IS NOT NULL ORDER BY b.name`, params),
        mssql(`SELECT DISTINCT t.order_status AS status ${JOINS} WHERE ${where} AND t.order_status IS NOT NULL ORDER BY t.order_status`, params),
      ]);
      return ok({ companies: companies.recordset, brokers: brokers.recordset, statuses: statuses.recordset.map(s => s.status) });
    }

    if (!q.from || !q.to) return badRequest('from and to (YYYY-MM-DD) required');
    const { where, params } = whereClause(q);

    if (q.rollup) {
      const r = await mssql(
        `SELECT c.company AS company, c.company_id AS company_id, MAX(b.id_number) AS broker_id,
                COUNT(*) AS orders,
                SUM(TRY_CONVERT(decimal(18,2), t.amount))           AS subtotal,
                SUM(TRY_CONVERT(decimal(18,2), t.transaction_cost)) AS cogs,
                SUM(TRY_CONVERT(decimal(18,2), t.total_cost))       AS total_cost,
                SUM(TRY_CONVERT(decimal(18,2), t.amount))           AS plan_paid
         ${JOINS} WHERE ${where}
         GROUP BY c.company, c.company_id
         ORDER BY c.company`, params);
      return ok({ rows: r.recordset });
    }

    const r = await mssql(
      `SELECT TOP ${DETAIL_MAX}
        t.order_status AS [Order Status],
        'W' + CAST(DATEPART(iso_week, ${D}) AS varchar(2)) + 'Y' + RIGHT(CAST(YEAR(${D}) AS varchar(4)), 2) AS [Week],
        b.id_number AS [Broker ID],
        c.company AS [Company Name],
        c.company_id AS [Company ID],
        CASE WHEN TRY_CONVERT(bigint, c.member_id) > 0 THEN c.member_id ELSE c.cardholder_id END AS [Member ID#],
        c.first_name AS [First Name],
        c.last_name AS [Last Name],
        c.date_of_birth AS [Date of Birth],
        COALESCE(pr.label, prd.label) AS [Medication Name],
        COALESCE(NULLIF(LTRIM(RTRIM(t.strength)), ''), pr.strength, prd.strength) AS [Strength],
        COALESCE(pr.unit_quantity, prd.unit_quantity) AS [Unit],
        t.reporting_qty AS [Reporting Quantity],
        t.drug_day_supply AS [Day Supply],
        t.order_number AS [Order Number],
        t.date_ordered AS [Order Date],
        t.shipping_amount AS [Shipping Amount],
        t.unit_cost AS [Unit Cost],
        t.unit_price AS [Unit Price],
        t.amount AS [Subtotal],
        t.transaction_cost AS [Cost of Goods Sold (COGS)],
        t.total_cost AS [Total Cost],
        t.amount AS [Plan Paid],
        t.shipped_date AS [Ship Date],
        t.tracking_number AS [Tracking Number],
        t.delivery_date AS [Date Delivered],
        t.instructions AS [Notes],
        0 AS [Rebate Amount],
        0 AS [Rebate Total],
        m.next_fill_order_date AS [Refill Date],
        t.is_paid AS [Is Paid],
        t.is_replacement AS [Replacement],
        t.irx_paid AS [IRX Paid],
        t.client_paid AS [Client Paid],
        t.vendor_paid AS [Vendor Paid]
       ${JOINS} WHERE ${where}
       ORDER BY ${D}, c.company, t.order_number`, params);
    return ok({ rows: r.recordset, total: r.recordset.length, capped: r.recordset.length === DETAIL_MAX });
  } catch (err) {
    return serverError(err);
  }
};
