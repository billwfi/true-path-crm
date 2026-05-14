const sql = require('mssql');

const config = {
  server: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 1433,
  database: process.env.DB_NAME || 'virtuallwell',
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: { encrypt: false, trustServerCertificate: true },
  connectionTimeout: 15000,
  requestTimeout: 15000,
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

let pool;

async function getPool() {
  if (!pool || !pool.connected) {
    pool = await sql.connect(config);
  }
  return pool;
}

module.exports = { getPool, sql };
