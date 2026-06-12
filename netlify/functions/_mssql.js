const sql = require('mssql');

// Connection to the iRx SQL Server (GLP1 data source).
// Configure via env vars (see .env.example):
//   SQLSERVER_HOST, SQLSERVER_DB, SQLSERVER_USER, SQLSERVER_PASSWORD, SQLSERVER_PORT
let poolPromise;

function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool({
      server: process.env.SQLSERVER_HOST,
      database: process.env.SQLSERVER_DB || 'iRx',
      user: process.env.SQLSERVER_USER,
      password: process.env.SQLSERVER_PASSWORD,
      port: parseInt(process.env.SQLSERVER_PORT, 10) || 1433,
      options: { encrypt: true, trustServerCertificate: true },
      pool: { max: 5, min: 0, idleTimeoutMillis: 30000 },
      connectionTimeout: 20000,
      requestTimeout: 30000,
    }).connect().catch(err => { poolPromise = null; throw err; });
  }
  return poolPromise;
}

// Run a parameterized query. params is an object: { name: value, ... }
async function mssql(query, params = {}) {
  const pool = await getPool();
  const req = pool.request();
  for (const [k, v] of Object.entries(params)) req.input(k, v);
  return req.query(query);
}

module.exports = { mssql, sql };
