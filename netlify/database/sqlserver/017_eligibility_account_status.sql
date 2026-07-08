-- ─────────────────────────────────────────────────────────────────────────────
-- Eligibility AccountStatus.
--   Active | Inactive — maintained by the client import reconcile: members present
--   in the latest file are 'Active'; members in eligibility for the carrier but no
--   longer in the file are set 'Inactive' (and MEMBER_THRU_DATE = load date).
--   Nullable; existing rows for other carriers are left untouched (NULL).
-- Run with:
--   node scripts/run-sql.js netlify/database/sqlserver/017_eligibility_account_status.sql
-- ─────────────────────────────────────────────────────────────────────────────

IF COL_LENGTH('dbo.eligibility', 'AccountStatus') IS NULL
  ALTER TABLE dbo.eligibility ADD AccountStatus VARCHAR(20) NULL;
GO
