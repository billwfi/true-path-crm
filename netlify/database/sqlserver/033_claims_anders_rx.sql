-- 033_claims_anders_rx.sql
-- Recreate dbo.ClaimsData_Anders to match the recurring Anders pharmacy claims
-- extract ("Rx Claim Details - ANDERS GROUP Upload into OnBase.xlsx").
--
-- Why recreate
--   The existing dbo.ClaimsData_Anders is a 462-column wide vendor warehouse
--   layout (1,533 rows, loaded 2026-01-27). The recurring file is a narrow
--   27-column Rx extract that shares only 7 column names with it, so it cannot
--   append cleanly -- 20 of its columns, including every cost field, have no
--   home. Rather than force the fit, the old table is preserved under a new
--   name and ClaimsData_Anders is rebuilt to the extract's own layout so the
--   standard add-only claims_loader.py can load it by identity column match.
--
--   Nothing in the app reads the old table -- Anders (carrier 000239911) is not
--   in claims.js SOURCES -- so the rename is safe.
--
-- Key
--   [Client ID] is injected as a constant = 000239911 (Anders' tp_clients
--   irx_client_id), matching how every other per-client claims table keys, so
--   the loader's dedupe/filter and any future claims.js routing line up with the
--   client record and the eligibility carrier. (The file's own Carrier ID TX8000
--   and Account ID 422624 are also loaded, as their own columns.)
--
-- Run: node scripts/run-sql.js netlify/database/sqlserver/033_claims_anders_rx.sql

-- ── Preserve the existing wide table ────────────────────────────────────────
IF OBJECT_ID('dbo.ClaimsData_Anders', 'U') IS NOT NULL
   AND OBJECT_ID('dbo.ClaimsData_Anders_Wide_Legacy', 'U') IS NULL
BEGIN
    -- Only rename the OLD wide layout, identified by a column unique to it.
    IF COL_LENGTH('dbo.ClaimsData_Anders', 'Claim Original ID') IS NOT NULL
        EXEC sp_rename 'dbo.ClaimsData_Anders', 'ClaimsData_Anders_Wide_Legacy';
END
GO

-- ── New narrow Rx-claims table ──────────────────────────────────────────────
-- Columns named exactly as the file headers so claims_loader.py maps by name.
-- All varchar to match the per-client claims-table convention (the app converts
-- dates/amounts on read); widths give headroom over the observed maxima.
IF OBJECT_ID('dbo.ClaimsData_Anders', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ClaimsData_Anders (
        [Client ID]              varchar(50)  NULL,   -- injected constant = 000239911
        [Claim ID]               varchar(50)  NULL,
        [Carrier ID]             varchar(50)  NULL,
        [Account ID]             varchar(50)  NULL,
        [Group ID]               varchar(50)  NULL,
        [Plan Code]              varchar(50)  NULL,
        [Member ID]              varchar(50)  NULL,
        [Member First Name]      varchar(100) NULL,
        [Member Last Name]       varchar(100) NULL,
        [Date of Birth]          varchar(50)  NULL,
        [NABP ID]                varchar(50)  NULL,
        [Pharmacy Name]          varchar(150) NULL,
        [Rx Number]              varchar(50)  NULL,
        [Date of Service]        varchar(50)  NULL,
        [Date Submitted]         varchar(50)  NULL,
        [Core Category]          varchar(100) NULL,
        [NDC]                    varchar(50)  NULL,
        [Drug Name and Strength] varchar(150) NULL,
        [Quantity Dispensed]     varchar(50)  NULL,
        [Days Supply]            varchar(50)  NULL,
        [Distribution Channel]   varchar(50)  NULL,
        [Drug Type]              varchar(50)  NULL,
        [Brand/Generic]          varchar(50)  NULL,
        [Formulary Indicator]    varchar(50)  NULL,
        [Mbr Paid]               varchar(50)  NULL,
        [Plan Paid]              varchar(50)  NULL,
        [Total Cost]             varchar(50)  NULL,
        [U&C Cost]               varchar(50)  NULL,
        [Loaded At]              datetime     NOT NULL CONSTRAINT DF_ClaimsData_Anders_LoadedAt DEFAULT GETDATE()
    );
    -- Claim ID is unique per claim line; enforce add-only idempotency in the DB.
    CREATE UNIQUE INDEX UX_ClaimsData_Anders_Claim
        ON dbo.ClaimsData_Anders ([Client ID], [Claim ID]);
END
GO
