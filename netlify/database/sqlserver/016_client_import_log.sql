-- ─────────────────────────────────────────────────────────────────────────────
-- Client SFTP import run log.
--   One row per feed run of scripts/client_imports/sftp_import.py (Eligibility /
--   Claims), recording when it ran, the file, row count, and status. Linked to a
--   client via client_id (tp_clients.id) so the CRM client page can show import
--   history later. Distinct from dbo.Import_Runs (that logs the SFTP worker's
--   Import_Configs runs; this logs the bespoke client_imports script).
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/016_client_import_log.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF OBJECT_ID('dbo.Client_Import_Log', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Client_Import_Log (
    id           INT IDENTITY(1,1) PRIMARY KEY,
    client_key   NVARCHAR(64)  NOT NULL,       -- registry key, e.g. 'mcrhotels'
    client_id    INT           NULL,           -- tp_clients.id (for the client page)
    group_id     NVARCHAR(64)  NULL,           -- CARRIER / GroupID (tp_clients.irx_client_id), e.g. 76416172
    group_name   NVARCHAR(200) NULL,           -- client / group name, e.g. 'MCR Hotels'
    feed_name    NVARCHAR(64)  NOT NULL,       -- 'Eligibility' | 'Claims'
    target_table NVARCHAR(200) NULL,
    file_name    NVARCHAR(400) NULL,           -- name of the file processed
    -- Running | Success | Error | NoFile
    status       NVARCHAR(20)  NOT NULL CONSTRAINT DF_CIL_status DEFAULT 'Running',
    rows_loaded  INT           NULL,           -- number of records loaded
    started_at   DATETIME      NOT NULL CONSTRAINT DF_CIL_started DEFAULT GETDATE(),  -- date processed
    finished_at  DATETIME      NULL,
    message      NVARCHAR(MAX) NULL
  );
  CREATE INDEX IX_Client_Import_Log_client ON dbo.Client_Import_Log(client_id, started_at DESC);
  CREATE INDEX IX_Client_Import_Log_key    ON dbo.Client_Import_Log(client_key, started_at DESC);
END
GO
