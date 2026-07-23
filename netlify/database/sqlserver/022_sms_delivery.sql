-- ─────────────────────────────────────────────────────────────────────────────
-- SMS delivery reports: carrier-level outcome per message (from ACS via Event Grid).
--   node scripts/run-sql.js netlify/database/sqlserver/022_sms_delivery.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.SMS_Log', 'delivery_status') IS NULL
  ALTER TABLE dbo.SMS_Log ADD
    delivery_status NVARCHAR(30)  NULL,   -- Delivered | Failed | ...
    delivery_detail NVARCHAR(200) NULL,
    delivered_at    DATETIME      NULL;
GO
