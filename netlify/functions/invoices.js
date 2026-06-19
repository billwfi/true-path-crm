const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, badRequest, notFound, serverError, options } = require('./_auth');

// WellSync transactions loaded for invoicing (see scripts/load_wellsync.py).
const TABLE = 'dbo.wellsync_data_June';
// completed_at is stored as an ISO string, e.g. 2025-12-30T18:14:10.941Z
const CDT = `TRY_CONVERT(datetime2, REPLACE(REPLACE(completed_at, 'Z', ''), 'T', ' '))`;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  const { detail, client_id, from, to, rates } = event.queryStringParameters || {};

  try {
    // Per-client contracted GLP1 rates (for the dashboard reconciliation table).
    if (rates) {
      const r = await mssql(
        `SELECT cl.id AS client_id, cl.name,
                MAX(b.tirzepatide_amount) AS tirz_rate,
                MAX(b.semaglutide_amount) AS sema_rate
         FROM tp_clients cl
         LEFT JOIN dbo.Client_Contracts ct ON ct.client_id = cl.id
         LEFT JOIN dbo.Client_Contract_Benefits b ON b.contract_id = ct.id AND b.type = 'GLP1'
         GROUP BY cl.id, cl.name`);
      return ok(r.recordset);
    }

    // Per-client invoice: completed WellSync transactions in a date range, priced by the
    // client's GLP1 benefit amounts (Tirzepatide / Semaglutide). Linked by GroupName = client name.
    if (client_id) {
      const cid = parseInt(client_id, 10);
      if (!cid) return badRequest('client_id required');
      const cl = await mssql(
        'SELECT id, name, irx_client_id, address, city, state, zip_code FROM tp_clients WHERE id=@id', { id: cid });
      const client = cl.recordset[0];
      if (!client) return notFound();

      const rt = await mssql(
        `SELECT MAX(b.tirzepatide_amount) AS tirz, MAX(b.semaglutide_amount) AS sema
         FROM dbo.Client_Contracts ct
         JOIN dbo.Client_Contract_Benefits b ON b.contract_id = ct.id
         WHERE ct.client_id = @id AND b.type = 'GLP1'`, { id: cid });
      const tirz = rt.recordset[0].tirz, sema = rt.recordset[0].sema;
      const fromD = from || '1900-01-01', toD = to || '2999-12-31';

      const det = await mssql(
        `SELECT last_name, first_name, patient_fullname AS member, patient_dob AS dob,
                medication, memberid,
                CONVERT(varchar(10), ${CDT}, 101) AS completed_date,
                CAST(CASE medication WHEN 'Tirzepatide' THEN @tirz
                                     WHEN 'Semaglutide' THEN @sema ELSE 0 END AS DECIMAL(18,2)) AS amount
         FROM ${TABLE}
         WHERE LTRIM(RTRIM(GroupName)) = @name AND status = 'completed'
           AND ${CDT} >= @from AND ${CDT} < DATEADD(day, 1, @to)
         ORDER BY ${CDT}, last_name, first_name`,
        { name: client.name, tirz: tirz || 0, sema: sema || 0, from: fromD, to: toD });

      return ok({ client, rates: { tirzepatide: tirz, semaglutide: sema },
        from: fromD, to: toD, detail: det.recordset });
    }

    // Row-level detail for the Invoice Data export.
    if (detail) {
      const r = await mssql(
        `SELECT GroupName            AS group_name,
                memberid             AS memberid,
                last_name            AS last_name,
                first_name           AS first_name,
                patient_dob          AS date_of_birth,
                medication           AS medication,
                status               AS status,
                is_completed         AS is_completed,
                CONVERT(varchar(10), ${CDT}, 101) AS completed_date
         FROM ${TABLE}
         ORDER BY GroupName, last_name, first_name`);
      return ok(r.recordset);
    }

    // Per-group rollup: distinct members, total rows, and completed (billable) rows.
    const groupsP = mssql(
      `SELECT GroupName AS group_name,
              COUNT(DISTINCT memberid) AS members,
              COUNT(*)                 AS row_count,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM ${TABLE}
       GROUP BY GroupName
       ORDER BY COUNT(*) DESC`);

    // Breakdown by transaction status.
    const statusP = mssql(
      `SELECT status, COUNT(*) AS n
       FROM ${TABLE}
       GROUP BY status
       ORDER BY COUNT(*) DESC`);

    // Invoice data: count by GroupName and month, completed transactions only.
    const monthP = mssql(
      `WITH c AS (SELECT GroupName, ${CDT} AS cdt FROM ${TABLE} WHERE status = 'completed')
       SELECT GroupName AS group_name, YEAR(cdt) AS yr, MONTH(cdt) AS mo, COUNT(*) AS n
       FROM c WHERE cdt IS NOT NULL
       GROUP BY GroupName, YEAR(cdt), MONTH(cdt)
       ORDER BY yr, mo, GroupName`);

    const [g, s, m] = await Promise.all([groupsP, statusP, monthP]);
    return ok({ groups: g.recordset, statuses: s.recordset, invoiceByMonth: m.recordset });
  } catch (err) {
    return serverError(err);
  }
};
