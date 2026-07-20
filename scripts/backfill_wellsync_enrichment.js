#!/usr/bin/env node
/*
 * Backfill the derived columns on dbo.wellsync_data_June.
 *
 * The June 2026 WellSync rows were added through the Invoice Data import tab,
 * which inserted only the 24 raw CSV columns and left the five derived ones
 * (last_name, first_name, medication, memberid, GroupName) blank. This fills
 * them in using the same SQL the import now runs (netlify/functions/
 * _wellsync_enrich.js), so both paths stay identical.
 *
 * Names and medication come from the row's own CSV fields, so every blank row
 * gets them. memberid/GroupName need an eligibility match and some rows have no
 * match — those are reported, not guessed.
 *
 * Usage:
 *   node scripts/backfill_wellsync_enrichment.js            # dry run (default)
 *   node scripts/backfill_wellsync_enrichment.js --commit   # apply
 *
 * Prereqs: SQLSERVER_HOST / SQLSERVER_USER / SQLSERVER_PASSWORD in the environment.
 */
const sql = require('mssql');
const { TABLE, LAST, FIRST, SQL_NAMES_MEDICATION, SQL_ELIGIBILITY, SQL_SIBLING_CARRY } = require('../netlify/functions/_wellsync_enrich');

const COMMIT = process.argv.includes('--commit');

// A blank row is one missing the derived columns.
const BLANK = `(GroupName IS NULL OR GroupName = '')`;

async function main() {
  if (!process.env.SQLSERVER_HOST) throw new Error('SQLSERVER_HOST not set');

  const pool = await new sql.ConnectionPool({
    server: process.env.SQLSERVER_HOST,
    database: process.env.SQLSERVER_DB || 'iRx',
    user: process.env.SQLSERVER_USER,
    password: process.env.SQLSERVER_PASSWORD,
    port: parseInt(process.env.SQLSERVER_PORT, 10) || 1433,
    options: { encrypt: true, trustServerCertificate: true },
    connectionTimeout: 20000,
    requestTimeout: 180000,
  }).connect();

  const q = async (text) => (await pool.request().query(text)).recordset;

  console.log(COMMIT ? '=== COMMIT MODE — changes will be written ===\n'
                     : '=== DRY RUN — no changes written (pass --commit to apply) ===\n');

  // ── Before ──────────────────────────────────────────────────────────────
  const before = (await q(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN ${BLANK} THEN 1 ELSE 0 END) AS blank
      FROM ${TABLE}`))[0];
  console.log(`${TABLE}: ${before.total} rows, ${before.blank} missing derived columns.\n`);

  // ── Rows that will NOT get memberid/GroupName (no eligibility match) ─────
  const unmatched = await q(`
    SELECT ${FIRST} AS first_name, ${LAST} AS last_name, patient_dob, service_service_name, status
      FROM ${TABLE} t
     WHERE ${BLANK}
       AND NOT EXISTS (
         SELECT 1 FROM dbo.vw_eligibility v
          WHERE UPPER(LTRIM(RTRIM(v.LAST_NAME)))  = UPPER(${LAST})
            AND UPPER(LTRIM(RTRIM(v.FIRST_NAME))) = UPPER(${FIRST})
            AND TRY_CONVERT(date, v.DATE_OF_BIRTH) = TRY_CONVERT(date, t.patient_dob))
     ORDER BY ${LAST}`);

  // ── Rows whose match is ambiguous (several eligibility records) ──────────
  const ambiguous = await q(`
    SELECT ${FIRST} AS first_name, ${LAST} AS last_name, patient_dob, c.n AS candidates
      FROM ${TABLE} t
     CROSS APPLY (
       SELECT COUNT(DISTINCT v.MEMBER_ID) AS n
         FROM dbo.vw_eligibility v
        WHERE UPPER(LTRIM(RTRIM(v.LAST_NAME)))  = UPPER(${LAST})
          AND UPPER(LTRIM(RTRIM(v.FIRST_NAME))) = UPPER(${FIRST})
          AND TRY_CONVERT(date, v.DATE_OF_BIRTH) = TRY_CONVERT(date, t.patient_dob)) c
     WHERE ${BLANK} AND c.n > 1
     ORDER BY ${LAST}`);

  console.log(`Will fill names + medication for all ${before.blank} blank rows.`);
  console.log(`Eligibility match: ${before.blank - unmatched.length} will get memberid/GroupName, ${unmatched.length} will not.\n`);

  if (ambiguous.length) {
    console.log(`--- ${ambiguous.length} ambiguous (multiple eligibility records; tiebreak picks the current one) ---`);
    console.table(ambiguous);
  }
  if (unmatched.length) {
    console.log(`--- ${unmatched.length} UNMATCHED — memberid/GroupName left blank for manual review ---`);
    console.table(unmatched);
  }

  if (!COMMIT) {
    console.log('\nDry run complete. Re-run with --commit to apply.');
    await pool.close();
    return;
  }

  // ── Apply ───────────────────────────────────────────────────────────────
  const n1 = (await pool.request().query(SQL_NAMES_MEDICATION)).rowsAffected[0];
  console.log(`\nNames + medication:              ${n1} rows updated.`);
  const n2 = (await pool.request().query(SQL_ELIGIBILITY)).rowsAffected[0];
  console.log(`memberid + GroupName (eligibility): ${n2} rows updated.`);
  const n3 = (await pool.request().query(SQL_SIBLING_CARRY)).rowsAffected[0];
  console.log(`memberid + GroupName (carried):     ${n3} rows updated.`);

  const after = (await q(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN ${BLANK} THEN 1 ELSE 0 END) AS still_blank_group,
           SUM(CASE WHEN last_name IS NULL OR last_name = '' THEN 1 ELSE 0 END) AS still_blank_name,
           SUM(CASE WHEN medication IS NULL OR medication = '' THEN 1 ELSE 0 END) AS still_blank_med
      FROM ${TABLE}`))[0];
  console.log(`\nAfter: ${after.total} rows | blank GroupName ${after.still_blank_group} | blank name ${after.still_blank_name} | blank medication ${after.still_blank_med}`);
  console.log('(Remaining blank GroupName rows are the unmatched ones listed above.)');

  await pool.close();
}

main().catch(err => { console.error('ERROR:', err.message || err); process.exit(1); });
