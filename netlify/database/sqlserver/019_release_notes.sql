-- ─────────────────────────────────────────────────────────────────────────────
-- Release Notes: a running dev log / changelog for the CRM. One row per entry,
-- tracked daily. Surfaced under the user menu > Release Notes.
--   node scripts/run-sql.js netlify/database/sqlserver/019_release_notes.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF OBJECT_ID('dbo.Release_Notes', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.Release_Notes (
    id         INT IDENTITY(1,1) PRIMARY KEY,
    entry_date DATE          NOT NULL CONSTRAINT DF_RN_date DEFAULT CAST(GETDATE() AS DATE),
    title      NVARCHAR(300) NOT NULL,
    category   NVARCHAR(30)  NULL,          -- Feature | Fix | Improvement | Infra | Data
    body       NVARCHAR(MAX) NULL,
    author_id  INT           NULL,
    created_at DATETIME      NOT NULL CONSTRAINT DF_RN_created DEFAULT GETDATE()
  );
  CREATE INDEX IX_Release_Notes_date ON dbo.Release_Notes(entry_date DESC, id DESC);
END
GO
