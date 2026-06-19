const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, serverError, options } = require('./_auth');

// WellSync transactions loaded for invoicing (see scripts/load_wellsync.py).
const TABLE = 'dbo.wellsync_data_June';
// completed_at is stored as an ISO string, e.g. 2025-12-30T18:14:10.941Z
const CDT = `TRY_CONVERT(datetime2, REPLACE(REPLACE(completed_at, 'Z', ''), 'T', ' '))`;

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();
  if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
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
