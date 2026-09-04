const sql = require('mssql');
const CFG = { server: '74.117.224.152', database: 'irx', user: 'claudeservices', password: 'Bunk?pjb8hah',
  options: { encrypt: true, trustServerCertificate: true }, pool: { max: 2 } };

const QUERIES = {
  'clients.list': `SELECT c.id,c.firstname,c.lastname,c.email,c.active,c.groups,c.created_at,
      co.name AS company, CONCAT(s.firstname,' ',s.lastname) AS coordinator
      FROM tp_clients c LEFT JOIN tp_companies co ON co.id=c.company_id
      LEFT JOIN tp_brokers b ON b.id=c.broker_id LEFT JOIN tp_staff s ON s.id=c.account_coordinator
      WHERE (NULL IS NULL OR CONCAT(c.firstname,' ',c.lastname) LIKE NULL) ORDER BY c.created_at DESC`,
  'companies.list': `SELECT * FROM tp_companies WHERE (NULL IS NULL OR name LIKE NULL) ORDER BY name`,
  'brokers.list': `SELECT * FROM tp_brokers WHERE (NULL IS NULL OR name LIKE NULL) ORDER BY name`,
  'leads.list': `SELECT l.id,l.name,l.status,CONCAT(s.firstname,' ',s.lastname) AS assigned_name
      FROM tp_leads l LEFT JOIN tp_staff s ON s.id=l.assigned_id
      WHERE (NULL IS NULL OR l.status=NULL) ORDER BY l.created_at DESC`,
  'tasks.list': `SELECT t.id,t.name,t.due_date,CONCAT(s.firstname,' ',s.lastname) AS assigned_name
      FROM tp_tasks t LEFT JOIN tp_staff s ON s.id=t.assigned_id
      WHERE (NULL IS NULL OR t.status=NULL)
      ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date ASC, t.created_at DESC`,
  'reminders.list': `SELECT r.id,r.description,r.is_closed,CONCAT(s.firstname,' ',s.lastname) AS staff_name
      FROM tp_reminders r LEFT JOIN tp_staff s ON s.id=r.staff_id
      WHERE r.reminder_date >= SYSUTCDATETIME() AND r.is_closed=0
      ORDER BY r.reminder_date ASC, r.created_at DESC`,
  'batch.list': `SELECT id,customer_name,status,created_at FROM tp_batch
      WHERE (NULL IS NULL OR status=NULL) ORDER BY created_at DESC`,
  'tempbatch.list': `SELECT * FROM tp_temp_batch WHERE status IN ('Pending','Error') ORDER BY created_at DESC`,
  'dash.clients': `SELECT COUNT(*) AS cnt FROM tp_clients WHERE active=1`,
  'dash.leads': `SELECT COUNT(*) AS cnt FROM tp_leads WHERE status NOT IN ('Converted','Lost')`,
  'dash.tasks': `SELECT COUNT(*) AS cnt FROM tp_tasks WHERE status <> 'Completed'`,
  'dash.batch_today': `SELECT COUNT(*) AS cnt FROM tp_batch WHERE CAST(created_at AS date)=CAST(SYSUTCDATETIME() AS date)`,
  'dash.due_tasks': `SELECT TOP 5 id,name,due_date FROM tp_tasks WHERE status <> 'Completed'
      AND due_date <= DATEADD(day,7,CAST(SYSUTCDATETIME() AS date)) ORDER BY due_date ASC`,
};

(async () => {
  const pool = await new sql.ConnectionPool(CFG).connect();
  let fail = 0;
  for (const [name, q] of Object.entries(QUERIES)) {
    try {
      const r = await pool.request().query(q);
      console.log(`OK   ${name}  (${r.recordset.length} rows)`);
    } catch (e) {
      fail++; console.log(`FAIL ${name}: ${e.message}`);
    }
  }
  // INSERT round-trip test (SCOPE_IDENTITY) in a rolled-back transaction
  const tx = new sql.Transaction(pool); await tx.begin();
  try {
    const r = await new sql.Request(tx).query(
      `INSERT INTO tp_companies (name,city) VALUES ('__test__','x'); SELECT CAST(SCOPE_IDENTITY() AS INT) AS id;`);
    console.log(`OK   insert.scope_identity -> id=${r.recordset[0].id}`);
    await tx.rollback();
  } catch (e) { fail++; console.log('FAIL insert.scope_identity:', e.message); await tx.rollback(); }
  await pool.close();
  console.log(fail ? `\n${fail} FAILED` : '\nALL QUERIES VALID');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
