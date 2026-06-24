const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, badRequest, serverError, options } = require('./_auth');

// Pharmacy claims for a client, read-only from dbo.ClaimsData.
// The link is ClaimsData.[Client ID] = tp_clients.irx_client_id (the CARRIER).
// Numeric/text columns in ClaimsData are stored as space-padded varchar, so we
// TRY_CONVERT amounts and LTRIM/RTRIM text.
//
//   GET ?carrier=X&from=&to=&drug=            -> { rows, summary, truncated }
//   GET ?carrier=X&from=&to=&drug=&report=1   -> aggregates for the Reporting tab

const ROW_LIMIT = 500;

// Build the shared WHERE clause + parameters from the query string.
function buildFilter(q) {
  const conds = ['[Client ID] = @carrier'];
  const params = { carrier: q.carrier };
  if (q.from) { conds.push('[Date Of Service] >= @from'); params.from = q.from; }
  if (q.to)   { conds.push('[Date Of Service] <= @to');   params.to = q.to; }
  if (q.drug) { conds.push('[Drug Name] LIKE @drug');     params.drug = `%${q.drug}%`; }
  return { where: conds.join(' AND '), params };
}

const SUMMARY_SELECT = `
  SELECT COUNT(*) AS claim_count,
         COUNT(DISTINCT NULLIF(LTRIM(RTRIM([Unique Utilizer])), '')) AS members,
         SUM(TRY_CONVERT(decimal(18,2), [Plan Paid]))  AS plan_paid,
         SUM(TRY_CONVERT(decimal(18,2), [Gross Cost])) AS gross_cost,
         SUM(TRY_CONVERT(decimal(18,2), [Copay]))      AS copay,
         AVG(TRY_CONVERT(decimal(18,2), [Days Supply])) AS avg_days_supply`;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  const q = event.queryStringParameters || {};
  if (!q.carrier) return badRequest('carrier is required');
  const { where, params } = buildFilter(q);

  try {
    if (q.report) {
      const [summary, byMonth, topDrugs, byGroup, brandGeneric, topPharmacies] = await Promise.all([
        mssql(`${SUMMARY_SELECT} FROM dbo.ClaimsData WHERE ${where}`, params),

        mssql(`SELECT CONVERT(varchar(7), [Date Of Service], 120) AS ym,
                      COUNT(*) AS claim_count,
                      SUM(TRY_CONVERT(decimal(18,2), [Plan Paid])) AS plan_paid
               FROM dbo.ClaimsData WHERE ${where}
               GROUP BY CONVERT(varchar(7), [Date Of Service], 120)
               ORDER BY ym`, params),

        mssql(`SELECT TOP 10 LTRIM(RTRIM([Drug Name])) AS drug,
                      COUNT(*) AS claim_count,
                      SUM(TRY_CONVERT(decimal(18,2), [Plan Paid]))  AS plan_paid,
                      SUM(TRY_CONVERT(decimal(18,2), [Gross Cost])) AS gross_cost
               FROM dbo.ClaimsData WHERE ${where}
               GROUP BY LTRIM(RTRIM([Drug Name]))
               ORDER BY claim_count DESC`, params),

        mssql(`SELECT TOP 12 LTRIM(RTRIM([GPI_02 Desc Drug Group MS])) AS grp,
                      COUNT(*) AS claim_count,
                      SUM(TRY_CONVERT(decimal(18,2), [Plan Paid])) AS plan_paid
               FROM dbo.ClaimsData WHERE ${where}
                 AND NULLIF(LTRIM(RTRIM([GPI_02 Desc Drug Group MS])), '') IS NOT NULL
               GROUP BY LTRIM(RTRIM([GPI_02 Desc Drug Group MS]))
               ORDER BY claim_count DESC`, params),

        mssql(`SELECT CASE WHEN [Name_Type MS] LIKE 'G%' THEN 'Generic'
                           WHEN [Name_Type MS] LIKE 'B%' THEN 'Brand'
                           ELSE 'Other' END AS kind,
                      COUNT(*) AS claim_count,
                      SUM(TRY_CONVERT(decimal(18,2), [Plan Paid])) AS plan_paid
               FROM dbo.ClaimsData WHERE ${where}
               GROUP BY CASE WHEN [Name_Type MS] LIKE 'G%' THEN 'Generic'
                             WHEN [Name_Type MS] LIKE 'B%' THEN 'Brand'
                             ELSE 'Other' END`, params),

        mssql(`SELECT TOP 8 LTRIM(RTRIM([Pharmacy Name])) AS pharmacy,
                      COUNT(*) AS claim_count,
                      SUM(TRY_CONVERT(decimal(18,2), [Plan Paid])) AS plan_paid
               FROM dbo.ClaimsData WHERE ${where}
                 AND NULLIF(LTRIM(RTRIM([Pharmacy Name])), '') IS NOT NULL
               GROUP BY LTRIM(RTRIM([Pharmacy Name]))
               ORDER BY claim_count DESC`, params),
      ]);

      return ok({
        summary: summary.recordset[0],
        byMonth: byMonth.recordset,
        topDrugs: topDrugs.recordset,
        byGroup: byGroup.recordset,
        brandGeneric: brandGeneric.recordset,
        topPharmacies: topPharmacies.recordset,
      });
    }

    // Claims list + summary.
    const [rows, summary] = await Promise.all([
      mssql(
        `SELECT TOP ${ROW_LIMIT}
                [Date Of Service] AS dos,
                LTRIM(RTRIM([Drug Name])) AS drug,
                LTRIM(RTRIM([Patient Last Name]))  AS last_name,
                LTRIM(RTRIM([Patient First Name])) AS first_name,
                TRY_CONVERT(int, [Quantity Dispensed]) AS qty,
                TRY_CONVERT(int, [Days Supply]) AS days_supply,
                LTRIM(RTRIM([Pharmacy Name])) AS pharmacy,
                LTRIM(RTRIM([GPI_02 Desc Drug Group MS])) AS drug_group,
                TRY_CONVERT(decimal(18,2), [Gross Cost]) AS gross_cost,
                TRY_CONVERT(decimal(18,2), [Plan Paid])  AS plan_paid,
                TRY_CONVERT(decimal(18,2), [Copay])      AS copay
         FROM dbo.ClaimsData WHERE ${where}
         ORDER BY [Date Of Service] DESC`, params),
      mssql(`${SUMMARY_SELECT} FROM dbo.ClaimsData WHERE ${where}`, params),
    ]);

    return ok({
      rows: rows.recordset,
      summary: summary.recordset[0],
      truncated: rows.recordset.length === ROW_LIMIT,
    });
  } catch (err) {
    return serverError(err);
  }
};
