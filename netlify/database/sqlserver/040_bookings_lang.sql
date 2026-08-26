-- ─────────────────────────────────────────────────────────────────────────────
-- Marketing › Schedulers: record which language the public booking page was in
-- when a registrant booked ('en' / 'es'), so the team can see who is Spanish-
-- speaking in the real-time notification and the daily recap.
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/040_bookings_lang.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.Bookings', 'lang') IS NULL
  ALTER TABLE dbo.Bookings ADD lang NVARCHAR(5) NULL CONSTRAINT DF_Bookings_lang DEFAULT 'en';
GO
