// Run a .sql file against SQL Server, splitting on GO batch separators
// (the mssql driver executes one batch at a time and does not parse GO).
const fs = require('fs');
const sql = require('mssql');

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/_runsql.js <file.sql>'); process.exit(1); }

const text = fs.readFileSync(file, 'utf8');
const batches = text.split(/^\s*GO\s*$/im).map(b => b.trim()).filter(Boolean);

(async () => {
  const pool = await new sql.ConnectionPool({
    server: process.env.SQLSERVER_HOST,
    database: process.env.SQLSERVER_DB || 'iRx',
    user: process.env.SQLSERVER_USER,
    password: process.env.SQLSERVER_PASSWORD,
    port: parseInt(process.env.SQLSERVER_PORT, 10) || 1433,
    options: { encrypt: true, trustServerCertificate: true },
    connectionTimeout: 20000,
  }).connect();
  for (let i = 0; i < batches.length; i++) {
    await pool.request().batch(batches[i]);
    console.log(`batch ${i + 1}/${batches.length} OK`);
  }
  await pool.close();
  console.log('Done:', file);
})().catch(e => { console.error('MSSQL ERROR:', e.message || e); process.exit(1); });
