const { getPool, sql } = require('./_db');
const { verifyToken, unauthorized, ok, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  try {
    const pool = await getPool();

    const [clients, leads, tasks, batch, pending] = await Promise.all([
      pool.request().query('SELECT COUNT(*) AS cnt FROM tp_clients WHERE active = 1'),
      pool.request().query("SELECT COUNT(*) AS cnt FROM tp_leads WHERE status NOT IN ('Converted','Lost')"),
      pool.request().query("SELECT COUNT(*) AS cnt FROM tp_tasks WHERE status NOT IN ('Completed')"),
      pool.request().query('SELECT COUNT(*) AS cnt FROM tp_batch WHERE CAST(created_at AS DATE) = CAST(GETDATE() AS DATE)'),
      pool.request().query("SELECT COUNT(*) AS cnt FROM tp_temp_batch WHERE status = 'Pending'"),
    ]);

    const recentLeads = await pool.request().query(
      'SELECT TOP 5 id, name, company, status, created_at FROM tp_leads ORDER BY created_at DESC'
    );
    const recentBatch = await pool.request().query(
      'SELECT TOP 5 id, customer_name, drug_name, vendor, status, transaction_date FROM tp_batch ORDER BY created_at DESC'
    );
    const dueTasks = await pool.request().query(
      "SELECT TOP 5 id, name, due_date, priority, status FROM tp_tasks WHERE status != 'Completed' AND due_date <= DATEADD(day, 7, GETDATE()) ORDER BY due_date ASC"
    );

    return ok({
      stats: {
        active_clients: clients.recordset[0].cnt,
        open_leads: leads.recordset[0].cnt,
        open_tasks: tasks.recordset[0].cnt,
        batch_today: batch.recordset[0].cnt,
        temp_batch_pending: pending.recordset[0].cnt,
      },
      recent_leads: recentLeads.recordset,
      recent_batch: recentBatch.recordset,
      due_tasks: dueTasks.recordset,
    });
  } catch (err) {
    return serverError(err);
  }
};
