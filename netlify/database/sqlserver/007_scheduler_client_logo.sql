-- ─────────────────────────────────────────────────────────────────────────────
-- Booking_Schedulers: optionally tie a scheduler to a specific client and show
-- that client's logo on the public booking page.
--   client_id   = tp_clients.id (Postgres); no cross-DB FK (existing convention).
--   client_name = denormalized label for display (avoids a cross-DB lookup).
--   logo_data   = uploaded client logo as a base64 data URL (small images only).
-- Columns added NULL so the migration is safe against existing rows.
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/007_scheduler_client_logo.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.Booking_Schedulers', 'client_id') IS NULL
  ALTER TABLE dbo.Booking_Schedulers ADD client_id INT NULL;
GO
IF COL_LENGTH('dbo.Booking_Schedulers', 'client_name') IS NULL
  ALTER TABLE dbo.Booking_Schedulers ADD client_name NVARCHAR(200) NULL;
GO
IF COL_LENGTH('dbo.Booking_Schedulers', 'logo_data') IS NULL
  ALTER TABLE dbo.Booking_Schedulers ADD logo_data NVARCHAR(MAX) NULL;
GO
