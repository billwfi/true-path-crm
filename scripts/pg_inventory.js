const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  const tbls = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
  console.log("=== Neon Postgres tables (public) ===");
  for (const { table_name } of tbls.rows) {
    const cnt = await pool.query(`SELECT COUNT(*) FROM "${table_name}"`);
    const cols = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name=$1 ORDER BY ordinal_position`, [table_name]);
    console.log(`\n• ${table_name}  (${cnt.rows[0].count} rows)`);
    console.log('   ' + cols.rows.map(c => `${c.column_name}:${c.data_type}`).join(', '));
  }
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
