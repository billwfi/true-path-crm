-- ─────────────────────────────────────────────────────────────────────────────
-- Bookings: allow an appointment to be assigned to a Client Concierge.
-- assigned_to references dbo.Users.id (a user whose role = 'Client Concierge').
-- assigned_at records when the assignment was last set. Columns are added NULL so
-- the migration is safe to run against existing rows.
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/014_booking_assignee.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.Bookings', 'assigned_to') IS NULL
  ALTER TABLE dbo.Bookings ADD assigned_to INT NULL;
GO
IF COL_LENGTH('dbo.Bookings', 'assigned_at') IS NULL
  ALTER TABLE dbo.Bookings ADD assigned_at DATETIME NULL;
GO
