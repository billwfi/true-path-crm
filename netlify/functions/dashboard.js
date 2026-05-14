const { db } = require('./_db');
const { verifyToken, unauthorized, ok, serverError, options } = require('./_auth');

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  if (!verifyToken(event)) return unauthorized();

  try {
    const [clients, leads, tasks, batch, pending, recentLeads, recentBatch, dueTasks] = await Promise.all([
      db('SELECT COUNT(*) AS cnt FROM tp_clients WHERE active = true'),
      db("SELECT COUNT(*) AS cnt FROM tp_leads WHERE status NOT IN ('Converted','Lost')"),
      db("SELECT COUNT(*) AS cnt FROM tp_tasks WHERE status != 'Completed'"),
      db("SELECT COUNT(*) AS cnt FROM tp_batch WHERE created_at::date = CURRENT_DATE"),
      db("SELECT COUNT(*) AS cnt FROM tp_temp_batch WHERE status = 'Pending'"),
      db('SELECT id,name,company,status,created_at FROM tp_leads ORDER BY created_at DESC LIMIT 5'),
      db('SELECT id,customer_name,drug_name,vendor,status,transaction_date FROM tp_batch ORDER BY created_at DESC LIMIT 5'),
      db("SELECT id,name,due_date,priority,status FROM tp_tasks WHERE status != 'Completed' AND due_date <= CURRENT_DATE + INTERVAL '7 days' ORDER BY due_date ASC LIMIT 5"),
    ]);

    return ok({
      stats: {
        active_clients:    Number(clients.rows[0].cnt),
        open_leads:        Number(leads.rows[0].cnt),
        open_tasks:        Number(tasks.rows[0].cnt),
        batch_today:       Number(batch.rows[0].cnt),
        temp_batch_pending:Number(pending.rows[0].cnt),
      },
      recent_leads:  recentLeads.rows,
      recent_batch:  recentBatch.rows,
      due_tasks:     dueTasks.rows,
    });
  } catch (err) {
    return serverError(err);
  }
};
