-- ─────────────────────────────────────────────────────────────────────────────
-- Import_Configs: manual "run now" trigger + end-of-data (footer) handling.
--
--   run_requested  : set to 1 by the app's "Run now" button; the worker runs the
--                    config on its next pass (regardless of schedule) and clears it.
--   stop_on_blank  : stop reading data at the first fully-blank row after the header.
--   stop_marker    : stop when a data row's first non-empty cell matches this text
--                    (case-insensitive), e.g. "Total" / "Grand Total".
--   footer_skip    : drop this many rows from the end of the data region.
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/011_import_run_and_footer.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.Import_Configs', 'run_requested') IS NULL
  ALTER TABLE dbo.Import_Configs ADD run_requested BIT NOT NULL CONSTRAINT DF_IC_runreq DEFAULT 0;
GO
IF COL_LENGTH('dbo.Import_Configs', 'stop_on_blank') IS NULL
  ALTER TABLE dbo.Import_Configs ADD stop_on_blank BIT NOT NULL CONSTRAINT DF_IC_stopblank DEFAULT 0;
GO
IF COL_LENGTH('dbo.Import_Configs', 'stop_marker') IS NULL
  ALTER TABLE dbo.Import_Configs ADD stop_marker NVARCHAR(200) NULL;
GO
IF COL_LENGTH('dbo.Import_Configs', 'footer_skip') IS NULL
  ALTER TABLE dbo.Import_Configs ADD footer_skip INT NOT NULL CONSTRAINT DF_IC_footer DEFAULT 0;
GO
