-- 039_fix_mcallen_staging.sql
-- Repair the City of McAllen eligibility staging table after a duplicate loader
-- corrupted its schema, and (with the code change below) retire that loader.
--
-- Background
--   Two loaders pointed at /InternationalRx/CityOfMcAllen: the scheduled,
--   reconciling import_worker config (canonical) and a dormant sftp_import.py
--   registry entry. A manual run of the registry entry on 2026-07-29 DROPPED and
--   re-created dbo.Eligibility_CityofMcAllen from the file header, sanitizing the
--   column names -- 'E-Mail_Address' became 'E_Mail_Address', 'SPEND-DOWN_AMOUNT'
--   became 'SPEND_DOWN_AMOUNT', the '..._(from_Member)' columns lost their parens.
--   That silently breaks the import_worker config's next load, whose column maps
--   still target the original AML names.
--
-- Fix
--   Rebuild the staging table from dbo.Eligibility_SmithCounty, a clean clone of
--   the original AML layout (verified to contain all of the config's mapped
--   columns). Staging only -- no canonical data is touched, and the config
--   truncate+reloads it on its next run. The duplicate registry entry is removed
--   in the same commit (scripts/client_imports/sftp_import.py).
--
-- Guarded on the presence of the original 'E-Mail_Address' column, so it runs
-- only while the table is in the sanitized state and is a no-op afterwards.
--
-- Run: node scripts/run-sql.js netlify/database/sqlserver/039_fix_mcallen_staging.sql

IF COL_LENGTH('dbo.Eligibility_CityofMcAllen', 'E-Mail_Address') IS NULL
BEGIN
    IF OBJECT_ID('dbo.Eligibility_CityofMcAllen', 'U') IS NOT NULL
        DROP TABLE dbo.Eligibility_CityofMcAllen;
    SELECT TOP 0 * INTO dbo.Eligibility_CityofMcAllen FROM dbo.Eligibility_SmithCounty;
END
GO
