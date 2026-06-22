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
  target_table, truncate_before, after_import, archive_dir,
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
    target_table: b.target_table, truncate: b.truncate_before ? 1 : 0,
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
        const cid = parseInt(config_id, 10);
        if (!cid) return badRequest('config_id is required');
        const r = await mssql(
          `SELECT TOP 50 id, config_id, started_at, finished_at, status, file_name, rows_imported, message
           FROM dbo.Import_Runs WHERE config_id = @cid ORDER BY started_at DESC`, { cid });
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
          `SELECT TOP 10 id, started_at, finished_at, status, file_name, rows_imported, message
           FROM dbo.Import_Runs WHERE config_id = @cid ORDER BY started_at DESC`, { cid });
        return ok({ ...mask(r.recordset[0]), columns: await loadColumns(cid), runs: runs.recordset });
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
            target_table, truncate_before, after_import, archive_dir,
            schedule_frequency, schedule_time, schedule_dow, active, created_by)
         OUTPUT INSERTED.id
         VALUES (@client_id, @name, @feed_type, @host, @port, @username, @pwd, @key,
            @remote_dir, @pattern, @format, @delimiter, @has_header, @header_row,
            @stop_on_blank, @stop_marker, @footer_skip, @sheet_name,
            @target_table, @truncate, @after_import, @archive_dir,
            @freq, @sched_time, @dow, @active, @by)`,
        { ...p, pwd: encrypt(b.sftp_password || null), key: encrypt(b.sftp_key || null), by: user.id || null });
      const newId = r.recordset[0].id;
      await saveColumns(newId, b.columns);
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
           sheet_name=@sheet_name, target_table=@target_table,
           truncate_before=@truncate, after_import=@after_import, archive_dir=@archive_dir,
           schedule_frequency=@freq, schedule_time=@sched_time, schedule_dow=@dow, active=@active,
           updated_at=GETDATE()${setPwd}${setKey}
         WHERE id=@cid`, params);
      if (!r.rowsAffected[0]) return notFound();
      if (Array.isArray(b.columns)) await saveColumns(cid, b.columns);
      return ok({ id: cid });
    }

    if (event.httpMethod === 'DELETE') {
      const cid = parseInt(id, 10);
      if (!cid) return badRequest('id is required');
      await mssql('DELETE FROM dbo.Import_Column_Maps WHERE config_id=@cid', { cid });
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
