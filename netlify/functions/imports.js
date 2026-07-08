const { mssql } = require('./_mssql');
const { encrypt } = require('./_crypto');
const { verifyToken, unauthorized, ok, created, badRequest, notFound, serverError, options, CORS } = require('./_auth');

// Eligibility & Claims Imports — per-client SFTP feed configuration + run history.
// The worker (scripts/import_worker.py) performs the actual SFTP pull + import.
// SFTP secrets are write-only here: encrypted on save, never returned.
//
//   GET                         -> list configs (optional ?client_id=)
//   GET  ?id=X                  -> one config + column maps + recent runs
//   GET  ?resource=runs&config_id=X     -> recent runs for a config
//   GET  ?resource=columns&table=dbo.x  -> column names of a target table
//   GET  ?resource=tables               -> candidate dbo base tables
//   POST                        -> create config (+ columns[])
//   PATCH ?id=X                 -> update config (+ columns[]; secrets only if sent)
//   DELETE ?id=X                -> delete config and its maps/runs

const FREQ = ['Hourly', 'Daily', 'Weekly'];
const FORMATS = ['csv', 'xlsx'];
const AFTER = ['leave', 'delete', 'archive'];

// Columns safe to return (everything except the encrypted secrets).
const CONFIG_COLS = `id, client_id, name, feed_type, sftp_host, sftp_port, sftp_username,
  remote_dir, file_pattern, file_format, delimiter, has_header, header_row,
  stop_on_blank, stop_marker, footer_skip, sheet_name,
  target_table, reconcile_table, truncate_before, after_import, archive_dir,
  schedule_frequency, schedule_time, schedule_dow, active, run_requested, last_run_at, created_at, updated_at`;

function isAdmin(u) { return !!u && (u.user_type === 'Admin' || u.is_admin === true); }

function mask(row) {
  // Drop nothing extra (CONFIG_COLS already excludes secrets) but expose presence flags.
  return row;
}

async function loadColumns(configId) {
  const r = await mssql(
    `SELECT id, source_column, target_column, data_type, ordinal
     FROM dbo.Import_Column_Maps WHERE config_id = @cid ORDER BY ordinal, id`, { cid: configId });
  return r.recordset;
}

// Replace the full column-map set for a config.
async function saveColumns(configId, columns) {
  await mssql('DELETE FROM dbo.Import_Column_Maps WHERE config_id = @cid', { cid: configId });
  if (!Array.isArray(columns)) return;
  let i = 0;
  for (const c of columns) {
    if (!c || !c.source_column || !c.target_column) continue;
    await mssql(
      `INSERT INTO dbo.Import_Column_Maps (config_id, source_column, target_column, data_type, ordinal)
       VALUES (@cid, @src, @tgt, @dt, @ord)`,
      { cid: configId, src: String(c.source_column), tgt: String(c.target_column),
        dt: c.data_type || null, ord: i++ });
  }
}

// Stage→canonical reconcile mapping (eligibility two-stage).
async function loadReconcileMaps(configId) {
  const r = await mssql(
    `SELECT id, stage_column, eligibility_column, ordinal
     FROM dbo.Import_Reconcile_Maps WHERE config_id = @cid ORDER BY ordinal, id`, { cid: configId });
  return r.recordset;
}

async function saveReconcileMaps(configId, columns) {
  await mssql('DELETE FROM dbo.Import_Reconcile_Maps WHERE config_id = @cid', { cid: configId });
  if (!Array.isArray(columns)) return;
  let i = 0;
  for (const c of columns) {
    if (!c || !c.stage_column || !c.eligibility_column) continue;
    await mssql(
      `INSERT INTO dbo.Import_Reconcile_Maps (config_id, stage_column, eligibility_column, ordinal)
       VALUES (@cid, @src, @tgt, @ord)`,
      { cid: configId, src: String(c.stage_column), tgt: String(c.eligibility_column), ord: i++ });
  }
}

function configParams(b) {
  const freq = FREQ.includes(b.schedule_frequency) ? b.schedule_frequency : 'Daily';
  return {
    client_id: parseInt(b.client_id, 10),
    name: b.name, feed_type: b.feed_type === 'Claims' ? 'Claims' : 'Eligibility',
    host: b.sftp_host, port: parseInt(b.sftp_port, 10) || 22, username: b.sftp_username,
    remote_dir: b.remote_dir || '/', pattern: b.file_pattern || '*.csv',
    format: FORMATS.includes(b.file_format) ? b.file_format : 'csv',
    delimiter: b.delimiter || ',', has_header: b.has_header === false ? 0 : 1,
    header_row: Math.max(1, parseInt(b.header_row, 10) || 1),
    stop_on_blank: b.stop_on_blank ? 1 : 0,
    stop_marker: b.stop_marker || null,
    footer_skip: Math.max(0, parseInt(b.footer_skip, 10) || 0),
    sheet_name: b.sheet_name || null,
    target_table: b.target_table, reconcile_table: b.reconcile_table || 'dbo.eligibility',
    truncate: b.truncate_before ? 1 : 0,
    after_import: AFTER.includes(b.after_import) ? b.after_import : 'leave',
    archive_dir: b.archive_dir || null,
    freq, sched_time: b.schedule_time || '06:00',
    dow: (b.schedule_dow === 0 || b.schedule_dow) ? parseInt(b.schedule_dow, 10) : null,
    active: b.active === false ? 0 : 1,
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return options();
  const user = verifyToken(event);
  if (!user) return unauthorized();
  if (!isAdmin(user)) return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'Admin access required' }) };

  const { id, client_id, resource, config_id, table } = event.queryStringParameters || {};

  try {
    if (event.httpMethod === 'GET') {
      if (resource === 'tables') {
        const r = await mssql(
          `SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS name
           FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'
           ORDER BY TABLE_SCHEMA, TABLE_NAME`);
        return ok(r.recordset.map(x => x.name));
      }
      if (resource === 'columns') {
        if (!table || !/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?$/.test(table)) return badRequest('valid table is required');
        const parts = table.split('.');
        const schema = parts.length > 1 ? parts[0] : 'dbo';
        const name = parts.length > 1 ? parts[1] : parts[0];
        const r = await mssql(
          `SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS
           WHERE TABLE_SCHEMA = @s AND TABLE_NAME = @t ORDER BY ORDINAL_POSITION`,
          { s: schema, t: name });
        return ok(r.recordset);
      }
      if (resource === 'runs') {
        // History for one feed (config_id) or for a whole client (client_id).
        if (client_id) {
          const clid = parseInt(client_id, 10);
          if (!clid) return badRequest('client_id is required');
          const r = await mssql(
            `SELECT TOP 100 r.id, r.config_id, c.name AS feed_name, c.feed_type,
                    r.started_at, r.finished_at, r.status, r.file_name, r.rows_imported,
                    r.added_count, r.updated_count, r.inactivated_count, r.message
             FROM dbo.Import_Runs r
             JOIN dbo.Import_Configs c ON c.id = r.config_id
             WHERE c.client_id = @clid ORDER BY r.started_at DESC`, { clid });
          return ok(r.recordset);
        }
        const cid = parseInt(config_id, 10);
        if (!cid) return badRequest('config_id is required');
        const r = await mssql(
          `SELECT TOP 50 id, config_id, started_at, finished_at, status, file_name, rows_imported,
                  added_count, updated_count, inactivated_count, message
           FROM dbo.Import_Runs WHERE config_id = @cid ORDER BY started_at DESC`, { cid });
        return ok(r.recordset);
      }
      if (resource === 'reconcile') {
        const rid = parseInt(event.queryStringParameters.run_id, 10);
        if (!rid) return badRequest('run_id is required');
        const r = await mssql(
          `SELECT TOP 5000 action, carrier, member_id, last_name, first_name, date_of_birth
           FROM dbo.Import_Reconcile_Items WHERE run_id = @rid
           ORDER BY action, last_name, first_name`, { rid });
        return ok(r.recordset);
      }
      if (id) {
        const cid = parseInt(id, 10);
        const r = await mssql(
          `SELECT ${CONFIG_COLS},
             CASE WHEN sftp_password_enc IS NULL THEN 0 ELSE 1 END AS has_password,
             CASE WHEN sftp_key_enc IS NULL THEN 0 ELSE 1 END AS has_key,
             (SELECT name FROM dbo.tp_clients c WHERE c.id = ic.client_id) AS client_name
           FROM dbo.Import_Configs ic WHERE id = @cid`, { cid });
        if (!r.recordset[0]) return notFound();
        const runs = await mssql(
          `SELECT TOP 10 id, started_at, finished_at, status, file_name, rows_imported,
                  added_count, updated_count, inactivated_count, message
           FROM dbo.Import_Runs WHERE config_id = @cid ORDER BY started_at DESC`, { cid });
        return ok({ ...mask(r.recordset[0]), columns: await loadColumns(cid),
          reconcile_columns: await loadReconcileMaps(cid), runs: runs.recordset });
      }
      // list
      const r = await mssql(
        `SELECT ${CONFIG_COLS.split(',').map(c => 'ic.' + c.trim()).join(', ')},
           CASE WHEN ic.sftp_password_enc IS NULL THEN 0 ELSE 1 END AS has_password,
           c.name AS client_name,
           (SELECT COUNT(*) FROM dbo.Import_Column_Maps m WHERE m.config_id = ic.id) AS mapping_count,
           (SELECT TOP 1 status FROM dbo.Import_Runs r WHERE r.config_id = ic.id ORDER BY started_at DESC) AS last_status
         FROM dbo.Import_Configs ic
         LEFT JOIN dbo.tp_clients c ON c.id = ic.client_id
         ${client_id ? 'WHERE ic.client_id = @cid' : ''}
         ORDER BY c.name, ic.name`,
        client_id ? { cid: parseInt(client_id, 10) } : {});
      return ok(r.recordset);
    }

    if (event.httpMethod === 'POST') {
      // Manual "Run now": flag the config; the worker runs it on its next pass.
      if (resource === 'run') {
        const cid = parseInt(id, 10);
        if (!cid) return badRequest('id is required');
        const r = await mssql('UPDATE dbo.Import_Configs SET run_requested = 1 WHERE id = @cid', { cid });
        return r.rowsAffected[0] ? ok({ queued: true }) : notFound();
      }

      // Manual file upload: the browser parses the file to { header, rows } and posts it
      // against an existing feed config. mode='analyze' previews what an import would do
      // (add/update/inactivate for eligibility, new/duplicate for claims) and writes
      // NOTHING. mode='commit' (Increment 2) will perform the writes.
      if (resource === 'manual') {
        return handleManual(event);
      }
      const b = JSON.parse(event.body || '{}');
      if (!b.client_id) return badRequest('client_id is required');
      if (!b.name) return badRequest('name is required');
      if (!b.sftp_host || !b.sftp_username) return badRequest('SFTP host and username are required');
      if (!b.target_table) return badRequest('target_table is required');
      const p = configParams(b);
      const r = await mssql(
        `INSERT INTO dbo.Import_Configs
           (client_id, name, feed_type, sftp_host, sftp_port, sftp_username, sftp_password_enc, sftp_key_enc,
            remote_dir, file_pattern, file_format, delimiter, has_header, header_row,
            stop_on_blank, stop_marker, footer_skip, sheet_name,
            target_table, reconcile_table, truncate_before, after_import, archive_dir,
            schedule_frequency, schedule_time, schedule_dow, active, created_by)
         OUTPUT INSERTED.id
         VALUES (@client_id, @name, @feed_type, @host, @port, @username, @pwd, @key,
            @remote_dir, @pattern, @format, @delimiter, @has_header, @header_row,
            @stop_on_blank, @stop_marker, @footer_skip, @sheet_name,
            @target_table, @reconcile_table, @truncate, @after_import, @archive_dir,
            @freq, @sched_time, @dow, @active, @by)`,
        { ...p, pwd: encrypt(b.sftp_password || null), key: encrypt(b.sftp_key || null), by: user.id || null });
      const newId = r.recordset[0].id;
      await saveColumns(newId, b.columns);
      await saveReconcileMaps(newId, b.reconcile_columns);
      return created({ id: newId });
    }

    if (event.httpMethod === 'PATCH') {
      const cid = parseInt(id, 10);
      if (!cid) return badRequest('id is required');
      const b = JSON.parse(event.body || '{}');
      const p = configParams(b);
      // Only overwrite secrets when a new value is supplied (blank = keep existing).
      const setPwd = b.sftp_password ? ', sftp_password_enc=@pwd' : (b.clear_password ? ', sftp_password_enc=NULL' : '');
      const setKey = b.sftp_key ? ', sftp_key_enc=@key' : (b.clear_key ? ', sftp_key_enc=NULL' : '');
      const params = { ...p, cid };
      if (b.sftp_password) params.pwd = encrypt(b.sftp_password);
      if (b.sftp_key) params.key = encrypt(b.sftp_key);
      const r = await mssql(
        `UPDATE dbo.Import_Configs SET
           client_id=@client_id, name=@name, feed_type=@feed_type, sftp_host=@host, sftp_port=@port,
           sftp_username=@username, remote_dir=@remote_dir, file_pattern=@pattern, file_format=@format,
           delimiter=@delimiter, has_header=@has_header, header_row=@header_row,
           stop_on_blank=@stop_on_blank, stop_marker=@stop_marker, footer_skip=@footer_skip,
           sheet_name=@sheet_name, target_table=@target_table, reconcile_table=@reconcile_table,
           truncate_before=@truncate, after_import=@after_import, archive_dir=@archive_dir,
           schedule_frequency=@freq, schedule_time=@sched_time, schedule_dow=@dow, active=@active,
           updated_at=GETDATE()${setPwd}${setKey}
         WHERE id=@cid`, params);
      if (!r.rowsAffected[0]) return notFound();
      if (Array.isArray(b.columns)) await saveColumns(cid, b.columns);
      if (Array.isArray(b.reconcile_columns)) await saveReconcileMaps(cid, b.reconcile_columns);
      return ok({ id: cid });
    }

    if (event.httpMethod === 'DELETE') {
      const cid = parseInt(id, 10);
      if (!cid) return badRequest('id is required');
      await mssql('DELETE FROM dbo.Import_Column_Maps WHERE config_id=@cid', { cid });
      await mssql('DELETE FROM dbo.Import_Reconcile_Maps WHERE config_id=@cid', { cid });
      await mssql('DELETE FROM dbo.Import_Reconcile_Items WHERE config_id=@cid', { cid });
      await mssql('DELETE FROM dbo.Import_Runs WHERE config_id=@cid', { cid });
      await mssql('DELETE FROM dbo.Import_Processed_Files WHERE config_id=@cid', { cid });
      const r = await mssql('DELETE FROM dbo.Import_Configs WHERE id=@cid', { cid });
      return r.rowsAffected[0] ? ok({ deleted: true }) : notFound();
    }

    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };
  } catch (err) {
    return serverError(err);
  }
};

// ── Manual upload (Node port of import_worker.py's map + reconcile) ───────────
const norm = v => String(v == null ? '' : v).trim();

// Bracket-qualify an admin-configured table name (schema.table). Never user input.
function qualifyTable(t) {
  if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?$/.test(String(t || ''))) return null;
  const parts = String(t).split('.');
  const schema = parts.length > 1 ? parts[0] : 'dbo';
  const name = parts.length > 1 ? parts[1] : parts[0];
  return `[${schema}].[${name}]`;
}

// Mirror import_worker.coerce for the value types we compare on in a preview.
function coerce(value, dtype) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s === '') return null;
  if (dtype === 'int') { const n = parseInt(s.replace(/,/g, ''), 10); return Number.isNaN(n) ? null : n; }
  if (dtype === 'decimal') { const n = Number(s.replace(/,/g, '')); return Number.isNaN(n) ? null : n; }
  return s;
}

function parseDateAny(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  const d = new Date(String(v).trim());
  return isNaN(d) ? null : d;
}

// Resolve each column mapping to a file position (header name, or 1-based index),
// then project every data row onto an object keyed by target column.
function mapRows(header, rows, maps) {
  const idx = {};
  (header || []).forEach((h, i) => { idx[norm(h)] = i; });
  const resolved = maps.map(m => {
    let pos = idx[norm(m.source_column)];
    if (pos === undefined && /^\d+$/.test(m.source_column)) pos = parseInt(m.source_column, 10) - 1;
    return { pos, target: m.target_column, dt: m.data_type };
  });
  const missingNames = resolved.map((r, i) => (r.pos === undefined ? maps[i].source_column : null)).filter(Boolean);
  if (missingNames.length) throw new Error(`Column(s) not found in file header: ${missingNames.join(', ')}`);
  const targetCols = resolved.map(r => r.target);
  const mapped = (rows || []).map(row => {
    const o = {};
    resolved.forEach(r => { o[r.target] = coerce(r.pos < row.length ? row[r.pos] : null, r.dt); });
    return o;
  });
  return { targetCols, mapped };
}

async function handleManual(event) {
  const { config_id } = event.queryStringParameters || {};
  const cid = parseInt(config_id, 10);
  if (!cid) return badRequest('config_id is required');

  const b = JSON.parse(event.body || '{}');
  const mode = b.mode === 'commit' ? 'commit' : 'analyze';
  if (!Array.isArray(b.header) || !Array.isArray(b.rows)) return badRequest('header and rows are required');
  if (!b.rows.length) return badRequest('The file has no data rows');

  const cfgR = await mssql(
    `SELECT id, client_id, feed_type, target_table, reconcile_table FROM dbo.Import_Configs WHERE id = @cid`, { cid });
  const cfg = cfgR.recordset[0];
  if (!cfg) return notFound();

  const maps = await loadColumns(cid);
  if (!maps.length) return badRequest('This feed has no column mapping defined yet (set it up under Imports).');

  let mapped, targetCols;
  try { ({ targetCols, mapped } = mapRows(b.header, b.rows, maps)); }
  catch (err) { return badRequest(err.message); }

  // Increment 1: preview only. The commit path lands in Increment 2.
  if (mode === 'commit') return badRequest('Commit is not enabled yet (Increment 2).');

  if (cfg.feed_type === 'Eligibility') {
    return ok(await previewEligibility(cfg, cid, mapped));
  }
  return ok(await previewClaims(cfg, targetCols, mapped));
}

// Compare the file roster to dbo.eligibility for this client (CARRIER = irx_client_id),
// keyed CARRIER + MEMBER_ID. Counts only — writes nothing.
async function previewEligibility(cfg, cid, mapped) {
  const recon = await loadReconcileMaps(cid);
  if (!recon.length) throw new Error('This eligibility feed has no reconcile mapping (staging → eligibility) defined.');

  const projected = mapped.map(o => {
    const e = {};
    recon.forEach(m => { e[m.eligibility_column] = o[m.stage_column] != null ? o[m.stage_column] : null; });
    return e;
  });
  if (!recon.some(m => m.eligibility_column === 'MEMBER_ID'))
    throw new Error('Eligibility feeds must map a column to MEMBER_ID.');

  const cr = await mssql('SELECT irx_client_id FROM dbo.tp_clients WHERE id = @id', { id: cfg.client_id });
  const carrier = norm(cr.recordset[0] && cr.recordset[0].irx_client_id);
  if (!carrier) throw new Error('Client has no irx_client_id; cannot scope eligibility by CARRIER.');

  const table = qualifyTable(cfg.reconcile_table || 'dbo.eligibility');
  if (!table) throw new Error('Invalid reconcile table configured.');

  const fileMembers = new Set();
  for (const e of projected) { const mid = norm(e.MEMBER_ID); if (mid) fileMembers.add(mid); }

  const ex = await mssql(
    `SELECT MEMBER_ID, MEMBER_THRU_DATE FROM ${table} WHERE CARRIER = @c`, { c: carrier });
  const existing = new Map();
  ex.recordset.forEach(r => existing.set(norm(r.MEMBER_ID), r.MEMBER_THRU_DATE));

  let adds = 0, updates = 0;
  for (const mid of fileMembers) (existing.has(mid) ? updates++ : adds++);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  let inactivations = 0;
  for (const [mid, thru] of existing) {
    if (!mid || fileMembers.has(mid)) continue;
    const t = parseDateAny(thru);           // blank/future thru = currently active
    if (t === null || t >= today) inactivations++;
  }

  return {
    feed_type: 'Eligibility', carrier, reconcile_table: cfg.reconcile_table || 'dbo.eligibility',
    file_rows: mapped.length, file_members: fileMembers.size,
    adds, updates, inactivations,
  };
}

// Count file rows already present in the claims target table (exact match on all
// mapped columns) vs. genuinely new. Reads only — writes nothing.
const CLAIMS_DEDUPE_MAX = 200000;   // above this, skip the in-memory full-row dedupe preview

async function previewClaims(cfg, targetCols, mapped) {
  const table = qualifyTable(cfg.target_table);
  if (!table) throw new Error('Invalid target table configured.');

  // Guard against hashing an enormous shared table (e.g. dbo.ClaimsData) in memory.
  const cnt = await mssql(`SELECT COUNT(*) AS n FROM ${table}`);
  const existingCount = cnt.recordset[0].n;
  if (existingCount > CLAIMS_DEDUPE_MAX) {
    return {
      feed_type: 'Claims', target_table: cfg.target_table, file_rows: mapped.length,
      new_rows: null, duplicates: null, existing_rows: existingCount, dedupe_skipped: true,
    };
  }

  const collist = targetCols.map(c => `[${c}]`).join(',');
  const ex = await mssql(`SELECT ${collist} FROM ${table}`);
  const keyOf = obj => targetCols.map(c => norm(obj[c])).join('␟');
  const seen = new Set(ex.recordset.map(keyOf));

  let duplicates = 0;
  const local = new Set();
  for (const o of mapped) {
    const k = keyOf(o);
    if (seen.has(k) || local.has(k)) duplicates++;
    else local.add(k);
  }
  return {
    feed_type: 'Claims', target_table: cfg.target_table,
    file_rows: mapped.length, new_rows: mapped.length - duplicates, duplicates,
    existing_rows: ex.recordset.length,
  };
}
