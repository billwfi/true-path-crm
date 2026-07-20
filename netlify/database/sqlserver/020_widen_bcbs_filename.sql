-- 020_widen_bcbs_filename.sql
-- The BCBS feed carries its own source filename in a trailing column. At
-- varchar(50) that column silently truncated under SSIS -- existing Gregg rows
-- read 'HRx_BCBS_dGREGGCOUNTYhonestrxEligibility20260531.t', losing the
-- extension. The June file's name is 52 characters, so the new worker fails the
-- insert outright rather than storing a corrupted value.
--
-- Widen to 260 (Windows MAX_PATH) on both BCBS staging tables.
--
-- Run: node scripts/run-sql.js netlify/database/sqlserver/020_widen_bcbs_filename.sql

IF COL_LENGTH('dbo.Eligibility_GreggCounty', 'FILENAME') < 260
    ALTER TABLE dbo.Eligibility_GreggCounty ALTER COLUMN FILENAME varchar(260) NULL;
GO

IF COL_LENGTH('dbo.Eligibility_CityofMission', 'FILENAME') < 260
    ALTER TABLE dbo.Eligibility_CityofMission ALTER COLUMN FILENAME varchar(260) NULL;
GO
