const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

(async () => {
  for (const t of ['tp_clients', 'tp_companies']) {
    const cols = await pool.query(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, [t]);
    console.log(`\n=== ${t} columns ===`);
    cols.rows.forEach(r => console.log(`  ${r.column_name} | ${r.data_type} | null=${r.is_nullable}${r.column_default ? ' | def=' + r.column_default : ''}`));
    const cnt = await pool.query(`SELECT COUNT(*) FROM ${t}`);
    console.log(`  rows: ${cnt.rows[0].count}`);
  }
  // Where is 'Workflow Innovators'?
  console.log("\n=== Workflow Innovators lookup ===");
  const c = await pool.query(`SELECT id, firstname, lastname, email, company_id FROM tp_clients
                              WHERE firstname ILIKE '%workflow%' OR lastname ILIKE '%workflow%' OR email ILIKE '%workflow%'`);
  console.log("  tp_clients matches:", JSON.stringify(c.rows));
  const co = await pool.query(`SELECT id, name FROM tp_companies WHERE name ILIKE '%workflow%'`);
  console.log("  tp_companies matches:", JSON.stringify(co.rows));
  // sample companies
  const sc = await pool.query(`SELECT id, name FROM tp_companies ORDER BY id LIMIT 10`);
  console.log("  tp_companies sample:", JSON.stringify(sc.rows));
  await pool.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
