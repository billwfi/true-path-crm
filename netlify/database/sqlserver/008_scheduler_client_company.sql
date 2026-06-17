-- ─────────────────────────────────────────────────────────────────────────────
-- Booking_Schedulers: store the associated client's company name so the public
-- booking page can pre-fill the "Company Name" field for client-specific
-- schedules. Kept separate from client_name (which is the display label).
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/008_scheduler_client_company.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.Booking_Schedulers', 'client_company') IS NULL
  ALTER TABLE dbo.Booking_Schedulers ADD client_company NVARCHAR(200) NULL;
GO
