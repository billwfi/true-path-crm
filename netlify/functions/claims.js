const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, badRequest, serverError, options } = require('./_auth');

// Pharmacy claims for a client, read-only.
//
// Claims are not in one table: most clients have their own dbo.ClaimsData_<Client>
// table, keyed on the CARRIER (= tp_clients.irx_client_id). Column names come in two
// variants — the shared dbo.ClaimsData uses "GPI_02 Desc Drug Group MS" / "Name_Type
// MS"; the per-client tables use the parenthesised "GPI_02 Desc (Drug Group) (MS)" /
// "Name_Type (MS)". SOURCES maps a carrier to its table + column profile; carriers not
// listed fall back to the shared dbo.ClaimsData. Numeric/text columns are space-padded
// varchar, so amounts use TRY_CONVERT and text is trimmed.
//
//   GET ?carrier=X&from=&to=&drug=            -> { rows, summary, truncated, source }
//   GET ?carrier=X&from=&to=&drug=&report=1   -> aggregates for the Reporting tab

const ROW_LIMIT = 500;

// Only the drug-group and name-type column names differ between the two layouts.
const PROFILES = {
  std:   { group: 'GPI_02 Desc Drug Group MS',     nameType: 'Name_Type MS' },
  paren: { group: 'GPI_02 Desc (Drug Group) (MS)', nameType: 'Name_Type (MS)' },
};

// irx_client_id (CARRIER) -> dedicated per-client claims table, for carriers NOT present
// in the shared dbo.ClaimsData. These tables use the "(parens)" layout, key on [Client
// ID], and store Date Of Service as varchar (US m/d/yyyy, or an Excel serial), so they
// use the 'us' date mode. McAllen/RHA stay on the shared table (clean real-date data).
const SOURCES = {
  '020373':{ table: 'ClaimsData_CSEAmericas',   idCol: 'Client ID', profile: 'paren', dates: 'us' },
  '10116': { table: 'ClaimsData_Caregiver',     idCol: 'Client ID', profile: 'paren', dates: 'us' },
  '909765':{ table: 'ClaimsData_FSG',           idCol: 'Client ID', profile: 'paren', dates: 'us' },
  '366696':{ table: 'ClaimsData_GreggCounty',   idCol: 'Client ID', profile: 'paren', dates: 'us' },
  IRX2026: { table: 'ClaimsData_iRx',           idCol: 'Client ID', profile: 'paren', dates: 'us' },
  // MCR Hotels: claims live in the normalized dbo.ClaimsData_Prod (keyed on clientid,
  // lowercase columns, NO cost columns). Uses the dedicated 'prod' layout below.
  '76416172':{ table: 'ClaimsData_Prod', idCol: 'clientid', layout: 'prod', dates: 'us' },
};
const DEFAULT_SOURCE = { table: 'ClaimsData', idCol: 'Client ID', profile: 'std', dates: 'native' };
const resolveSource = (carrier) => SOURCES[carrier] || DEFAULT_SOURCE;

// A real DATE expression for [Date Of Service]. Per-client tables store it as a US-format
// varchar or (e.g. RHA) an Excel serial number; the shared table is already a date.
function dateExpr(mode) {
  return mode === 'us'
    ? `COALESCE(TRY_CONVERT(date, [Date Of Service], 101), DATEADD(day, TRY_CONVERT(int, [Date Of Service]) - 2, '1900-01-01'))`
    : '[Date Of Service]';
}

// Build the shared WHERE clause + parameters. `idCol`/`D` are expressions built from our
// own constants (never user input); the carrier value is bound. The CARRIER match trims
// padding and strips a leading text-marker apostrophe some imports add.
function buildFilter(q, idCol, D) {
  const conds = [`REPLACE(LTRIM(RTRIM(${idCol})), '''', '') = @carrier`];
  const params = { carrier: q.carrier };
  if (q.from) { conds.push(`${D} >= @from`); params.from = q.from; }
  if (q.to)   { conds.push(`${D} <= @to`);   params.to = q.to; }
  if (q.drug) { conds.push('[Drug Name] LIKE @drug'); params.drug = `%${q.drug}%`; }
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

  const src = resolveSource(q.carrier);

  try {
    // ClaimsData_Prod-backed clients (e.g. MCR Hotels): different schema, keyed on
    // clientid, with no cost columns (Plan Paid / Gross Cost / Copay unavailable).
    if (src.layout === 'prod') return await claimsProd(q);

    const T  = `dbo.[${src.table}]`;
    const G  = `[${PROFILES[src.profile].group}]`;
    const NT = `[${PROFILES[src.profile].nameType}]`;
    const D  = dateExpr(src.dates);
    const { where, params } = buildFilter(q, `[${src.idCol}]`, D);

    if (q.report) {
      const [summary, byMonth, topDrugs, byGroup, brandGeneric, topPharmacies] = await Promise.all([
        mssql(`${SUMMARY_SELECT} FROM ${T} WHERE ${where}`, params),

        mssql(`SELECT CONVERT(varchar(7), ${D}, 120) AS ym,
                      COUNT(*) AS claim_count,
                      SUM(TRY_CONVERT(decimal(18,2), [Plan Paid])) AS plan_paid
               FROM ${T} WHERE ${where}
               GROUP BY CONVERT(varchar(7), ${D}, 120)
               ORDER BY ym`, params),

        mssql(`SELECT TOP 10 LTRIM(RTRIM([Drug Name])) AS drug,
                      COUNT(*) AS claim_count,
                      SUM(TRY_CONVERT(decimal(18,2), [Plan Paid]))  AS plan_paid,
                      SUM(TRY_CONVERT(decimal(18,2), [Gross Cost])) AS gross_cost
               FROM ${T} WHERE ${where}
               GROUP BY LTRIM(RTRIM([Drug Name]))
               ORDER BY claim_count DESC`, params),

        mssql(`SELECT TOP 12 LTRIM(RTRIM(${G})) AS grp,
                      COUNT(*) AS claim_count,
                      SUM(TRY_CONVERT(decimal(18,2), [Plan Paid])) AS plan_paid
               FROM ${T} WHERE ${where}
                 AND NULLIF(LTRIM(RTRIM(${G})), '') IS NOT NULL
               GROUP BY LTRIM(RTRIM(${G}))
               ORDER BY claim_count DESC`, params),

        mssql(`SELECT CASE WHEN ${NT} LIKE 'G%' THEN 'Generic'
                           WHEN ${NT} LIKE 'B%' THEN 'Brand'
                           ELSE 'Other' END AS kind,
                      COUNT(*) AS claim_count,
                      SUM(TRY_CONVERT(decimal(18,2), [Plan Paid])) AS plan_paid
               FROM ${T} WHERE ${where}
               GROUP BY CASE WHEN ${NT} LIKE 'G%' THEN 'Generic'
                             WHEN ${NT} LIKE 'B%' THEN 'Brand'
                             ELSE 'Other' END`, params),

        mssql(`SELECT TOP 8 LTRIM(RTRIM([Pharmacy Name])) AS pharmacy,
                      COUNT(*) AS claim_count,
                      SUM(TRY_CONVERT(decimal(18,2), [Plan Paid])) AS plan_paid
               FROM ${T} WHERE ${where}
                 AND NULLIF(LTRIM(RTRIM([Pharmacy Name])), '') IS NOT NULL
               GROUP BY LTRIM(RTRIM([Pharmacy Name]))
               ORDER BY claim_count DESC`, params),
      ]);

      return ok({
        source: src.table,
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
                ${D} AS dos,
                LTRIM(RTRIM([Drug Name])) AS drug,
                LTRIM(RTRIM([Patient Last Name]))  AS last_name,
                LTRIM(RTRIM([Patient First Name])) AS first_name,
                TRY_CONVERT(int, [Quantity Dispensed]) AS qty,
                TRY_CONVERT(int, [Days Supply]) AS days_supply,
                LTRIM(RTRIM([Pharmacy Name])) AS pharmacy,
                LTRIM(RTRIM(${G})) AS drug_group,
                TRY_CONVERT(decimal(18,2), [Gross Cost]) AS gross_cost,
                TRY_CONVERT(decimal(18,2), [Plan Paid])  AS plan_paid,
                TRY_CONVERT(decimal(18,2), [Copay])      AS copay
         FROM ${T} WHERE ${where}
         ORDER BY ${D} DESC`, params),
      mssql(`${SUMMARY_SELECT} FROM ${T} WHERE ${where}`, params),
    ]);

    return ok({
      source: src.table,
      rows: rows.recordset,
      summary: summary.recordset[0],
      truncated: rows.recordset.length === ROW_LIMIT,
    });
  } catch (err) {
    return serverError(err);
  }
};

// ClaimsData_Prod layout: normalized utilization schema keyed on `clientid`, with
// lowercase column names and NO cost columns — Plan Paid / Gross Cost / Copay come
// back NULL, and there's no brand/generic (Name_Type) source. Drug group falls back
// to the GPI-02 code. Date Of Service is a US m/d/yyyy (or ISO) varchar.
async function claimsProd(q) {
  const T = 'dbo.ClaimsData_Prod';
  const D = `COALESCE(TRY_CONVERT(date, dateofservice, 101), TRY_CONVERT(date, dateofservice, 23))`;
  const conds = [`REPLACE(LTRIM(RTRIM(clientid)), '''', '') = @carrier`];
  const params = { carrier: q.carrier };
  if (q.from) { conds.push(`${D} >= @from`); params.from = q.from; }
  if (q.to)   { conds.push(`${D} <= @to`);   params.to = q.to; }
  if (q.drug) { conds.push('drugname LIKE @drug'); params.drug = `%${q.drug}%`; }
  const where = conds.join(' AND ');

  const SUMMARY = `SELECT COUNT(*) AS claim_count,
    COUNT(DISTINCT NULLIF(LTRIM(RTRIM(patientid)), '')) AS members,
    NULL AS plan_paid, NULL AS gross_cost, NULL AS copay,
    AVG(TRY_CONVERT(decimal(18,2), dayssupply)) AS avg_days_supply`;

  if (q.report) {
    const [summary, byMonth, topDrugs, byGroup, topPharmacies] = await Promise.all([
      mssql(`${SUMMARY} FROM ${T} WHERE ${where}`, params),
      mssql(`SELECT CONVERT(varchar(7), ${D}, 120) AS ym, COUNT(*) AS claim_count, NULL AS plan_paid
             FROM ${T} WHERE ${where} AND ${D} IS NOT NULL
             GROUP BY CONVERT(varchar(7), ${D}, 120) ORDER BY ym`, params),
      mssql(`SELECT TOP 10 LTRIM(RTRIM(drugname)) AS drug, COUNT(*) AS claim_count,
                    NULL AS plan_paid, NULL AS gross_cost
             FROM ${T} WHERE ${where} AND NULLIF(LTRIM(RTRIM(drugname)), '') IS NOT NULL
             GROUP BY LTRIM(RTRIM(drugname)) ORDER BY claim_count DESC`, params),
      mssql(`SELECT TOP 12 LTRIM(RTRIM(gpi02)) AS grp, COUNT(*) AS claim_count, NULL AS plan_paid
             FROM ${T} WHERE ${where} AND NULLIF(LTRIM(RTRIM(gpi02)), '') IS NOT NULL
             GROUP BY LTRIM(RTRIM(gpi02)) ORDER BY claim_count DESC`, params),
      mssql(`SELECT TOP 8 LTRIM(RTRIM(pharmacyname)) AS pharmacy, COUNT(*) AS claim_count, NULL AS plan_paid
             FROM ${T} WHERE ${where} AND NULLIF(LTRIM(RTRIM(pharmacyname)), '') IS NOT NULL
             GROUP BY LTRIM(RTRIM(pharmacyname)) ORDER BY claim_count DESC`, params),
    ]);
    return ok({
      source: 'ClaimsData_Prod', hasCost: false,
      summary: summary.recordset[0],
      byMonth: byMonth.recordset,
      topDrugs: topDrugs.recordset,
      byGroup: byGroup.recordset,
      brandGeneric: [],
      topPharmacies: topPharmacies.recordset,
    });
  }

  const [rows, summary] = await Promise.all([
    mssql(
      `SELECT TOP ${ROW_LIMIT} ${D} AS dos,
              LTRIM(RTRIM(drugname)) AS drug,
              LTRIM(RTRIM(patientlastname))  AS last_name,
              LTRIM(RTRIM(patientfirstname)) AS first_name,
              TRY_CONVERT(int, quantitydispensed) AS qty,
              TRY_CONVERT(int, dayssupply) AS days_supply,
              LTRIM(RTRIM(pharmacyname)) AS pharmacy,
              LTRIM(RTRIM(gpi02)) AS drug_group,
              NULL AS gross_cost, NULL AS plan_paid, NULL AS copay
       FROM ${T} WHERE ${where} ORDER BY ${D} DESC`, params),
    mssql(`${SUMMARY} FROM ${T} WHERE ${where}`, params),
  ]);
  return ok({
    source: 'ClaimsData_Prod', hasCost: false,
    rows: rows.recordset, summary: summary.recordset[0],
    truncated: rows.recordset.length === ROW_LIMIT,
  });
}
