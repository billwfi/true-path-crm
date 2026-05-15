const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

async function db(text, params = []) {
  try {
    return await getPool().query(text, params);
  } catch (err) {
    pool = null;
    throw err;
  }
}

module.exports = { db };
