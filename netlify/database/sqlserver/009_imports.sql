-- ─────────────────────────────────────────────────────────────────────────────
-- Eligibility & Claims Imports — per-client SFTP feeds.
--
-- The web app manages configuration and shows run history; a worker on the SQL
-- box (scripts/import_worker.py) connects to SFTP, downloads matching files,
-- maps columns, and inserts them into a target table. SFTP secrets are stored
-- AES-256-GCM encrypted (key in env IMPORT_CRYPT_KEY, shared by the app + worker).
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/009_imports.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- One feed definition per client (a client may have several, e.g. eligibility + claims).
IF OBJECT_ID('dbo.Import_Configs', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Import_Configs (
    id                 INT IDENTITY(1,1) PRIMARY KEY,
    client_id          INT           NOT NULL,        -- tp_clients.id
    name               NVARCHAR(200) NOT NULL,
    feed_type          NVARCHAR(20)  NOT NULL CONSTRAINT DF_IC_feed DEFAULT 'Eligibility', -- Eligibility | Claims
    -- SFTP connection
    sftp_host          NVARCHAR(255) NOT NULL,
    sftp_port          INT           NOT NULL CONSTRAINT DF_IC_port DEFAULT 22,
    sftp_username      NVARCHAR(200) NOT NULL,
    sftp_password_enc  NVARCHAR(MAX) NULL,             -- AES-256-GCM ciphertext (see _crypto.js)
    sftp_key_enc       NVARCHAR(MAX) NULL,             -- optional encrypted private key (PEM)
    remote_dir         NVARCHAR(400) NOT NULL CONSTRAINT DF_IC_dir DEFAULT '/',
    file_pattern       NVARCHAR(200) NOT NULL CONSTRAINT DF_IC_pat DEFAULT '*.csv', -- glob
    -- File parsing
    file_format        NVARCHAR(20)  NOT NULL CONSTRAINT DF_IC_fmt DEFAULT 'csv',  -- csv | xlsx
    delimiter          NVARCHAR(8)   NULL CONSTRAINT DF_IC_delim DEFAULT ',',
    has_header         BIT           NOT NULL CONSTRAINT DF_IC_hdr DEFAULT 1,
    sheet_name         NVARCHAR(128) NULL,             -- xlsx; NULL = first sheet
    -- Target
    target_table       NVARCHAR(200) NOT NULL,         -- e.g. dbo.eligibility
    truncate_before    BIT           NOT NULL CONSTRAINT DF_IC_trunc DEFAULT 0,  -- full refresh vs append
    after_import       NVARCHAR(20)  NOT NULL CONSTRAINT DF_IC_after DEFAULT 'leave', -- leave | delete | archive
    archive_dir        NVARCHAR(400) NULL,
    -- Schedule (worker polls and runs configs that are due)
    schedule_frequency NVARCHAR(20)  NOT NULL CONSTRAINT DF_IC_freq DEFAULT 'Daily', -- Hourly | Daily | Weekly
    schedule_time      NVARCHAR(5)   NULL CONSTRAINT DF_IC_time DEFAULT '06:00',     -- HH:mm (Daily/Weekly)
    schedule_dow       INT           NULL,             -- 0=Sun..6=Sat (Weekly)
    active             BIT           NOT NULL CONSTRAINT DF_IC_active DEFAULT 1,
    last_run_at        DATETIME      NULL,
    created_by         INT           NULL,
    created_at         DATETIME      NOT NULL CONSTRAINT DF_IC_created DEFAULT GETDATE(),
    updated_at         DATETIME      NOT NULL CONSTRAINT DF_IC_updated DEFAULT GETDATE()
  );
  CREATE INDEX IX_Import_Configs_client ON dbo.Import_Configs(client_id);
END
GO

-- Column mapping: source file column -> target table column.
IF OBJECT_ID('dbo.Import_Column_Maps', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Import_Column_Maps (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    config_id     INT           NOT NULL,
    source_column NVARCHAR(200) NOT NULL,   -- header name (or 1-based index when no header)
    target_column NVARCHAR(200) NOT NULL,
    data_type     NVARCHAR(40)  NULL,       -- optional cast: string | int | decimal | date | datetime
    ordinal       INT           NULL
  );
  CREATE INDEX IX_Import_Column_Maps_config ON dbo.Import_Column_Maps(config_id);
END
GO

-- One row per worker execution of a config.
IF OBJECT_ID('dbo.Import_Runs', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Import_Runs (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    config_id     INT           NOT NULL,
    started_at    DATETIME      NOT NULL CONSTRAINT DF_IR_started DEFAULT GETDATE(),
    finished_at   DATETIME      NULL,
    -- Running | Success | Error | NoFile
    status        NVARCHAR(20)  NOT NULL CONSTRAINT DF_IR_status DEFAULT 'Running',
    file_name     NVARCHAR(400) NULL,
    rows_imported INT           NULL,
    message       NVARCHAR(MAX) NULL
  );
  CREATE INDEX IX_Import_Runs_config ON dbo.Import_Runs(config_id, started_at DESC);
END
GO

-- Tracks files already imported so the worker doesn't re-import them.
IF OBJECT_ID('dbo.Import_Processed_Files', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Import_Processed_Files (
    id            INT IDENTITY(1,1) PRIMARY KEY,
    config_id     INT           NOT NULL,
    file_name     NVARCHAR(400) NOT NULL,
    file_modified DATETIME      NULL,
    rows_imported INT           NULL,
    processed_at  DATETIME      NOT NULL CONSTRAINT DF_IPF_at DEFAULT GETDATE()
  );
  CREATE UNIQUE INDEX UX_Import_Processed_Files ON dbo.Import_Processed_Files(config_id, file_name);
END
GO
