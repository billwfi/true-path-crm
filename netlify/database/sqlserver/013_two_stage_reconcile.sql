-- ─────────────────────────────────────────────────────────────────────────────
-- Two-stage eligibility import.
--   Stage 1 (raw load): the file is loaded into the feed's target_table as-is,
--     using the existing Import_Column_Maps (file column -> staging column). The
--     staging table is truncated first so it holds only the current roster.
--   Stage 2 (reconcile): the staging table is compared to the canonical table
--     (reconcile_table, default dbo.eligibility) scoped by CARRIER = client's
--     irx_client_id, keyed CARRIER + MEMBER_ID. Import_Reconcile_Maps says which
--     staging column feeds each canonical eligibility column.
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/013_two_stage_reconcile.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.Import_Configs', 'reconcile_table') IS NULL
  ALTER TABLE dbo.Import_Configs ADD reconcile_table NVARCHAR(200) NULL
    CONSTRAINT DF_IC_recontbl DEFAULT 'dbo.eligibility';
GO

IF OBJECT_ID('dbo.Import_Reconcile_Maps', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Import_Reconcile_Maps (
    id                 INT IDENTITY(1,1) PRIMARY KEY,
    config_id          INT           NOT NULL,
    stage_column       NVARCHAR(200) NOT NULL,   -- column in the staging/target table
    eligibility_column NVARCHAR(200) NOT NULL,   -- canonical column in reconcile_table
    ordinal            INT           NULL
  );
  CREATE INDEX IX_Import_Reconcile_Maps_config ON dbo.Import_Reconcile_Maps(config_id);
END
GO
