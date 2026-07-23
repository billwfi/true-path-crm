-- ─────────────────────────────────────────────────────────────────────────────
-- SMS (Azure Communication Services): outbound send log + opt-out list.
--   node scripts/run-sql.js netlify/database/sqlserver/021_sms.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF OBJECT_ID('dbo.SMS_OptOut', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.SMS_OptOut (
    phone_number NVARCHAR(20) NOT NULL PRIMARY KEY,   -- E.164
    opted_out_at DATETIME     NOT NULL CONSTRAINT DF_OptOut_at DEFAULT GETDATE(),
    source       NVARCHAR(30) NULL                     -- STOP reply | manual | import
  );
END
GO

IF OBJECT_ID('dbo.SMS_Log', 'U') IS NULL
BEGIN
  CREATE TABLE dbo.SMS_Log (
    id          INT IDENTITY(1,1) PRIMARY KEY,
    to_number   NVARCHAR(20)  NOT NULL,
    from_number NVARCHAR(20)  NULL,
    message     NVARCHAR(MAX) NULL,
    message_id  NVARCHAR(100) NULL,
    status      NVARCHAR(20)  NULL,   -- sent | failed | error
    error       NVARCHAR(400) NULL,
    member_key  NVARCHAR(50)  NULL,
    sent_by     INT           NULL,
    created_at  DATETIME      NOT NULL CONSTRAINT DF_SMSLog_at DEFAULT GETDATE()
  );
  CREATE INDEX IX_SMS_Log_created ON dbo.SMS_Log(created_at DESC);
END
GO
