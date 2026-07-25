-- ─────────────────────────────────────────────────────────────────────────────
-- Email opt-out (unsubscribe) list. Suppresses future campaign sends.
--   node scripts/run-sql.js netlify/database/sqlserver/024_email_optout.sql
-- ─────────────────────────────────────────────────────────────────────────────
IF OBJECT_ID('dbo.Email_OptOut','U') IS NULL
BEGIN
  CREATE TABLE dbo.Email_OptOut (
    email        NVARCHAR(200) NOT NULL PRIMARY KEY,   -- lowercased
    opted_out_at DATETIME      NOT NULL CONSTRAINT DF_EOO_at DEFAULT GETDATE(),
    source       NVARCHAR(30)  NULL
  );
END
GO
