#!/usr/bin/env node
/*
 * Replicate table + view STRUCTURES (no data) from a source SQL Server database
 * to a target database on the same server. Used to stand up iRx_Dev as a schema
 * mirror of iRx for the Azure dev/staging environments.
 *
 * Copies, per table: columns (types/length/precision/scale/nullability),
 * IDENTITY, computed columns, column DEFAULT constraints, and the PRIMARY KEY.
 * Then creates views (OBJECT_DEFINITION) with multiple passes to satisfy
 * view-on-view dependencies. Foreign keys and secondary indexes are NOT copied
 * (not needed for app correctness in dev).
 *
 * Usage:
 *   IRX_DB_PWD=... node scripts/replicate_schema.js <SRC_DB> <DST_DB> [--commit]
 *   (dry run by default — prints what it would create)
 */
const sql = require('mssql');

const SRC = process.argv[2] || 'iRx';
const DST = process.argv[3] || 'iRx_Dev';
const COMMIT = process.argv.includes('--commit');
const PWD = process.env.IRX_DB_PWD;
if (!PWD) { console.error('Set IRX_DB_PWD'); process.exit(1); }

const cfg = (database) => ({
  server: '74.117.224.152', port: 1433, user: 'claudeservices', password: PWD, database,
  options: { encrypt: true, trustServerCertificate: true },
  connectionTimeout: 20000, requestTimeout: 120000,
});

// Types whose length we render as (n) / (max).
const STR_TYPES = new Set(['char', 'varchar', 'binary', 'varbinary', 'nchar', 'nvarchar']);
const SCALE_TYPES = new Set(['datetime2', 'time', 'datetimeoffset']);

function typeSpec(c) {
  const t = c.typename.toLowerCase();
  if (STR_TYPES.has(t)) {
    if (c.max_length === -1) return `${t}(max)`;
    const n = (t === 'nchar' || t === 'nvarchar') ? c.max_length / 2 : c.max_length;
    return `${t}(${n})`;
  }
  if (t === 'decimal' || t === 'numeric') return `${t}(${c.precision},${c.scale})`;
  if (SCALE_TYPES.has(t)) return `${t}(${c.scale})`;
  return t;
}

function columnDDL(c) {
  const name = `[${c.name}]`;
  if (c.is_computed) {
    return `${name} AS ${c.computed_def}${c.is_persisted ? ' PERSISTED' : ''}`;
  }
  let s = `${name} ${typeSpec(c)}`;
  if (c.is_identity) s += ` IDENTITY(${c.seed_value || 1},${c.increment_value || 1})`;
  s += c.is_nullable ? ' NULL' : ' NOT NULL';
  if (c.default_def) s += ` DEFAULT ${c.default_def}`;
  return s;
}

async function main() {
  const src = await new sql.ConnectionPool(cfg(SRC)).connect();
  const dst = await new sql.ConnectionPool(cfg(DST)).connect();
  console.log(`${COMMIT ? 'COMMIT' : 'DRY RUN'}: ${SRC} -> ${DST}\n`);

  const tables = (await src.request().query(
    `SELECT s.name sch, t.name tbl FROM sys.tables t
       JOIN sys.schemas s ON s.schema_id=t.schema_id ORDER BY t.name`)).recordset;

  let made = 0, skipped = 0, failed = [];
  for (const { sch, tbl } of tables) {
    const full = `[${sch}].[${tbl}]`;
    const exists = (await dst.request().query(
      `SELECT OBJECT_ID('${sch}.${tbl}') id`)).recordset[0].id;
    if (exists) { skipped++; continue; }

    const cols = (await src.request().input('t', `${sch}.${tbl}`).query(`
      SELECT c.column_id, c.name, ty.name typename, c.max_length, c.precision, c.scale,
             c.is_nullable, c.is_identity, c.is_computed,
             cc.definition computed_def, cc.is_persisted,
             ic.seed_value, ic.increment_value,
             dc.definition default_def
        FROM sys.columns c
        JOIN sys.types ty ON ty.user_type_id=c.user_type_id
        LEFT JOIN sys.computed_columns cc ON cc.object_id=c.object_id AND cc.column_id=c.column_id
        LEFT JOIN sys.identity_columns ic ON ic.object_id=c.object_id AND ic.column_id=c.column_id
        LEFT JOIN sys.default_constraints dc ON dc.parent_object_id=c.object_id AND dc.parent_column_id=c.column_id
       WHERE c.object_id=OBJECT_ID(@t) ORDER BY c.column_id`)).recordset;

    const pk = (await src.request().input('t', `${sch}.${tbl}`).query(`
      SELECT col.name FROM sys.key_constraints kc
        JOIN sys.index_columns ic ON ic.object_id=kc.parent_object_id AND ic.index_id=kc.unique_index_id
        JOIN sys.columns col ON col.object_id=ic.object_id AND col.column_id=ic.column_id
       WHERE kc.parent_object_id=OBJECT_ID(@t) AND kc.type='PK' ORDER BY ic.key_ordinal`)).recordset;

    const defs = cols.map(columnDDL);
    if (pk.length) defs.push(`CONSTRAINT [PK_${tbl}] PRIMARY KEY (${pk.map(p => `[${p.name}]`).join(', ')})`);
    const ddl = `CREATE TABLE ${full} (\n  ${defs.join(',\n  ')}\n)`;

    if (!COMMIT) { console.log(`-- would create ${full} (${cols.length} cols${pk.length ? ', PK' : ''})`); made++; continue; }
    try { await dst.request().query(ddl); console.log(`+ ${full} (${cols.length} cols)`); made++; }
    catch (e) { console.log(`FAIL ${full}: ${e.message}`); failed.push({ full, err: e.message, ddl }); }
  }

  // ── Views (multi-pass for view-on-view dependencies) ──────────────────────
  const views = (await src.request().query(
    `SELECT s.name sch, v.name vw FROM sys.views v
       JOIN sys.schemas s ON s.schema_id=v.schema_id`)).recordset;
  let pending = [];
  for (const { sch, vw } of views) {
    const def = (await src.request().query(
      `SELECT OBJECT_DEFINITION(OBJECT_ID('${sch}.${vw}')) d`)).recordset[0].d;
    pending.push({ full: `[${sch}].[${vw}]`, sch, vw, def });
  }
  let vmade = 0;
  if (COMMIT) {
    for (let pass = 0; pass < 5 && pending.length; pass++) {
      const still = [];
      for (const v of pending) {
        const exists = (await dst.request().query(`SELECT OBJECT_ID('${v.sch}.${v.vw}') id`)).recordset[0].id;
        if (exists) continue;
        try { await dst.request().batch(v.def); console.log(`+ view ${v.full}`); vmade++; }
        catch (e) { still.push(v); }
      }
      pending = still;
    }
    pending.forEach(v => console.log(`FAIL view ${v.full} (unresolved deps)`));
  } else {
    pending.forEach(v => console.log(`-- would create view ${v.full}`));
    vmade = pending.length;
  }

  console.log(`\n${COMMIT ? 'Created' : 'Would create'}: ${made} tables, ${vmade} views. Skipped ${skipped} existing.`);
  if (failed.length) console.log(`Failures: ${failed.length} (see above).`);
  await src.close(); await dst.close();
}
main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
