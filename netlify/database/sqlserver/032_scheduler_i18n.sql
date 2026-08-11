-- ─────────────────────────────────────────────────────────────────────────────
-- Marketing › Schedulers: optional Spanish title/description for the public
-- booking page. When a visitor toggles the page to Español, the header and
-- description use these if set, otherwise they fall back to the English fields.
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/032_scheduler_i18n.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.Booking_Schedulers', 'name_es') IS NULL
  ALTER TABLE dbo.Booking_Schedulers ADD name_es NVARCHAR(200) NULL;
GO

IF COL_LENGTH('dbo.Booking_Schedulers', 'description_es') IS NULL
  ALTER TABLE dbo.Booking_Schedulers ADD description_es NVARCHAR(MAX) NULL;
GO

-- Seed Spanish titles for the existing enrollment schedulers (brand names kept).
UPDATE dbo.Booking_Schedulers
   SET name_es = N'Programación de Llamada de Inscripción de RxCompass'
 WHERE name = 'RxCompass Enrollment Call Scheduling' AND (name_es IS NULL OR name_es = '');

UPDATE dbo.Booking_Schedulers
   SET name_es = N'Llamada de Inscripción de TruePath Sourcing'
 WHERE name = 'TruePath Sourcing Enrollment Call' AND (name_es IS NULL OR name_es = '');
GO
