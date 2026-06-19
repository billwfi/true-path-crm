const { mssql } = require('./_mssql');
const { verifyToken, unauthorized, ok, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  try {
    const [clients, leads, tasks, batch, pending, recentLeads, recentBatch, dueTasks] = await Promise.all([
      mssql('SELECT COUNT(*) AS cnt FROM tp_clients WHERE active = 1'),
      mssql("SELECT COUNT(*) AS cnt FROM tp_leads WHERE status NOT IN ('Converted','Lost')"),
      mssql("SELECT COUNT(*) AS cnt FROM tp_tasks WHERE status <> 'Completed'"),
      mssql("SELECT COUNT(*) AS cnt FROM tp_batch WHERE CAST(created_at AS date) = CAST(SYSUTCDATETIME() AS date)"),
      mssql("SELECT COUNT(*) AS cnt FROM tp_temp_batch WHERE status = 'Pending'"),
      mssql('SELECT TOP 5 id,name,company,status,created_at FROM tp_leads ORDER BY created_at DESC'),
      mssql('SELECT TOP 5 id,customer_name,drug_name,vendor,status,transaction_date FROM tp_batch ORDER BY created_at DESC'),
      mssql("SELECT TOP 5 id,name,due_date,priority,status FROM tp_tasks WHERE status <> 'Completed' AND due_date <= DATEADD(day, 7, CAST(SYSUTCDATETIME() AS date)) ORDER BY due_date ASC"),
    ]);

    return ok({
      stats: {
        active_clients:    Number(clients.recordset[0].cnt),
        open_leads:        Number(leads.recordset[0].cnt),
        open_tasks:        Number(tasks.recordset[0].cnt),
        batch_today:       Number(batch.recordset[0].cnt),
        temp_batch_pending:Number(pending.recordset[0].cnt),
      },
      recent_leads:  recentLeads.recordset,
      recent_batch:  recentBatch.recordset,
      due_tasks:     dueTasks.recordset,
    });
  } catch (err) {
    return serverError(err);
  }
};
