const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, serverError, options } = require('./_auth');

// Liviniti (RxCompass) eligibility feed — tracking view.
//   GET -> { runs, summary, byCompany }
//   runs      : recent Client_Import_Log rows for client_key='liviniti'
//   summary   : current dbo.Eligibility_Liviniti totals (rows, companies, batch date)
//   byCompany : per-company member counts in the current load
exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();

  try {
    const runs = (await mssql(
      `SELECT TOP 50 id, feed_name, target_table, file_name, status, rows_loaded, finished_at, message
       FROM dbo.Client_Import_Log
       WHERE client_key = 'liviniti'
       ORDER BY id DESC`)).recordset;

    let summary = null;
    let byCompany = [];
    const oid = (await mssql("SELECT OBJECT_ID('dbo.Eligibility_Liviniti','U') AS oid")).recordset[0].oid;
    if (oid) {
      summary = (await mssql(
        `SELECT COUNT(*) AS rows_total,
                COUNT(DISTINCT CompanyName) AS companies,
                CONVERT(varchar(10), MAX(FileDate), 23) AS batch_date,
                MAX(LoadedAt) AS loaded_at
         FROM dbo.Eligibility_Liviniti`)).recordset[0];
      byCompany = (await mssql(
        `SELECT TOP 300 CompanyName, COUNT(*) AS members
         FROM dbo.Eligibility_Liviniti
         GROUP BY CompanyName
         ORDER BY COUNT(*) DESC`)).recordset;
    }

    return ok({ runs, summary, byCompany });
  } catch (err) {
    return serverError(err);
  }
};
