-- ─────────────────────────────────────────────────────────────────────────────
-- Eligibility reconciliation results.
--
-- For feed_type = 'Eligibility', after a file is loaded the worker compares it to
-- dbo.eligibility scoped by CARRIER = the client's irx_client_id, keyed on
-- CARRIER + MEMBER_ID:
--   * file member not in eligibility  -> INSERT (Add)
--   * file member already present      -> UPDATE mapped fields
--   * eligibility member missing from file and still active
--     (MEMBER_THRU_DATE blank or >= today) -> set MEMBER_THRU_DATE = run date (Inactivate)
-- Per-run counts are stored on Import_Runs; the Add/Inactivate detail goes into
-- Import_Reconcile_Items for the report.
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/012_eligibility_reconcile.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.Import_Runs', 'added_count') IS NULL
  ALTER TABLE dbo.Import_Runs ADD added_count INT NULL;
GO
IF COL_LENGTH('dbo.Import_Runs', 'updated_count') IS NULL
  ALTER TABLE dbo.Import_Runs ADD updated_count INT NULL;
GO
IF COL_LENGTH('dbo.Import_Runs', 'inactivated_count') IS NULL
  ALTER TABLE dbo.Import_Runs ADD inactivated_count INT NULL;
GO

IF OBJECT_ID('dbo.Import_Reconcile_Items', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Import_Reconcile_Items (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    run_id        INT           NOT NULL,
    config_id     INT           NOT NULL,
    action        NVARCHAR(20)  NOT NULL,   -- Add | Inactivate
    carrier       NVARCHAR(50)  NULL,
    member_id     NVARCHAR(100) NULL,
    last_name     NVARCHAR(200) NULL,
    first_name    NVARCHAR(200) NULL,
    date_of_birth NVARCHAR(40)  NULL,
    created_at    DATETIME      NOT NULL CONSTRAINT DF_IRI_at DEFAULT GETDATE()
  );
  CREATE INDEX IX_Import_Reconcile_run ON dbo.Import_Reconcile_Items(run_id, action);
END
GO
