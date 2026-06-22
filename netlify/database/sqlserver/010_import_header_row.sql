-- ─────────────────────────────────────────────────────────────────────────────
-- Import_Configs: some feeds have report titles / blank rows above the real
-- column header. header_row = the 1-based file row where the header columns are
-- (e.g. the RHA Excel file's header is on row 7). Data starts on the next row.
-- When has_header = 0, header_row is the first data row. Defaults to 1 (no change
-- in behavior for existing feeds).
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/010_import_header_row.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.Import_Configs', 'header_row') IS NULL
  ALTER TABLE dbo.Import_Configs ADD header_row INT NOT NULL CONSTRAINT DF_IC_hrow DEFAULT 1;
GO
