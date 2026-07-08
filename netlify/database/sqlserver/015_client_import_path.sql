-- ─────────────────────────────────────────────────────────────────────────────
-- Per-client import file path.
--   Files are received/sent over SFTP; this records the folder or path a client's
--   import/export files live in, shown on the Demographics tab and used as a hint
--   when configuring the client's import feeds. Free text (e.g. an SFTP remote dir).
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/015_client_import_path.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.tp_clients', 'import_file_path') IS NULL
  ALTER TABLE dbo.tp_clients ADD import_file_path NVARCHAR(400) NULL;
GO
