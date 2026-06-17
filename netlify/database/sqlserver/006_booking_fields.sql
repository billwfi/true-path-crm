-- ─────────────────────────────────────────────────────────────────────────────
-- Bookings: capture richer registrant details collected on the public page.
-- Required at submit time: company_name, first_name, last_name, dob, phone.
-- Optional: email, notes. The existing `name` column is kept populated with
-- "First Last" so older admin views keep working. Columns are added NULL so the
-- migration is safe to run against any existing rows.
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/006_booking_fields.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.Bookings', 'company_name') IS NULL
  ALTER TABLE dbo.Bookings ADD company_name NVARCHAR(200) NULL;
GO
IF COL_LENGTH('dbo.Bookings', 'first_name') IS NULL
  ALTER TABLE dbo.Bookings ADD first_name NVARCHAR(100) NULL;
GO
IF COL_LENGTH('dbo.Bookings', 'last_name') IS NULL
  ALTER TABLE dbo.Bookings ADD last_name NVARCHAR(100) NULL;
GO
IF COL_LENGTH('dbo.Bookings', 'dob') IS NULL
  ALTER TABLE dbo.Bookings ADD dob DATE NULL;
GO
