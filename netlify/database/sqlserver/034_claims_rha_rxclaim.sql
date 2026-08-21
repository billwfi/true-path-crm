-- 034_claims_rha_rxclaim.sql
-- Rebuild dbo.ClaimsData_RHA for RHA's new RxCLAIM-format claims export
-- ("RHA Claims <range>.xlsx", 79 cols), and standardize RHA claims on
-- dbo.ClaimsData_Prod (the table the app reads), matching Anders and MCR Hotels.
--
-- Background
--   RHA switched claims formats. The old per-client dbo.ClaimsData_RHA is the
--   64-column HRx layout (35,062 rows); the new file is a 79-column RxCLAIM/PBM
--   export that shares almost no column names with it. The old table is
--   preserved under a new name; ClaimsData_RHA is rebuilt to the RxCLAIM layout
--   so the standard add-only claims_loader.py can load it by identity match, and
--   reconcile.py normalizes it into ClaimsData_Prod.
--
-- Key
--   The file has no Client ID column of its own; [Client ID] is injected as the
--   constant PSI4105 (RHA's carrier / irx_client_id) so the loader and the app's
--   prod routing line up. RxCLAIM Number + RxCLAIM Sequence Number is unique per
--   claim line (verified 12,582/12,582) and is the add-only dedupe key.
--
-- Run: node scripts/run-sql.js netlify/database/sqlserver/034_claims_rha_rxclaim.sql

-- ── Preserve the existing HRx table ─────────────────────────────────────────
IF OBJECT_ID('dbo.ClaimsData_RHA', 'U') IS NOT NULL
   AND OBJECT_ID('dbo.ClaimsData_RHA_HRx_Legacy', 'U') IS NULL
BEGIN
    -- Identify the OLD HRx layout by a column unique to it (absent from RxCLAIM).
    IF COL_LENGTH('dbo.ClaimsData_RHA', 'Unique Utilizer') IS NOT NULL
        EXEC sp_rename 'dbo.ClaimsData_RHA', 'ClaimsData_RHA_HRx_Legacy';
END
GO

-- ── New RxCLAIM-layout table ────────────────────────────────────────────────
-- Columns named exactly as the file headers so claims_loader.py maps by name.
-- All varchar (the app converts dates/amounts on read); text fields get headroom.
IF OBJECT_ID('dbo.ClaimsData_RHA', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.ClaimsData_RHA (
        [Client ID]                      varchar(50)  NULL,   -- injected constant = PSI4105
        [Carrier ID]                     varchar(50)  NULL,
        [Carrier Name]                   varchar(120) NULL,
        [Account ID]                     varchar(50)  NULL,
        [Account Name]                   varchar(120) NULL,
        [Group ID]                       varchar(50)  NULL,
        [Group Name]                     varchar(120) NULL,
        [Plan Code]                      varchar(50)  NULL,
        [Member ID]                      varchar(50)  NULL,
        [Member Last Name]               varchar(100) NULL,
        [Member First Name]              varchar(100) NULL,
        [Member Middle Initial]          varchar(20)  NULL,
        [Member Gender]                  varchar(20)  NULL,
        [Member Date of Birth]           varchar(50)  NULL,
        [Member Address 1]               varchar(120) NULL,
        [Member Address 2]               varchar(120) NULL,
        [Member City]                    varchar(80)  NULL,
        [Member State]                   varchar(20)  NULL,
        [Member Zip]                     varchar(20)  NULL,
        [Member Phone]                   varchar(30)  NULL,
        [Date Filled]                    varchar(50)  NULL,
        [Date Submitted]                 varchar(50)  NULL,
        [RxCLAIM Number]                 varchar(50)  NULL,
        [RxCLAIM Sequence Number]        varchar(50)  NULL,
        [RxCLAIM Status]                 varchar(50)  NULL,
        [Rx Number]                      varchar(50)  NULL,
        [Refill Number]                  varchar(20)  NULL,
        [Claim Origin Code]              varchar(50)  NULL,
        [Prescriber Submitted ID]        varchar(50)  NULL,
        [Prescriber DEA ID]              varchar(50)  NULL,
        [Prescriber NPI]                 varchar(50)  NULL,
        [Prescriber Last Name]           varchar(100) NULL,
        [Prescriber First Name]          varchar(100) NULL,
        [Prescriber Middle Initial]      varchar(20)  NULL,
        [Prescriber Degree]              varchar(30)  NULL,
        [Prescriber Address 1]           varchar(120) NULL,
        [Prescriber Address 2]           varchar(120) NULL,
        [Prescriber City]                varchar(80)  NULL,
        [Prescriber State]               varchar(20)  NULL,
        [Prescriber Zip]                 varchar(20)  NULL,
        [Prescriber Phone]               varchar(30)  NULL,
        [Prescriber Fax]                 varchar(30)  NULL,
        [Pharmacy Submitted ID]          varchar(50)  NULL,
        [Pharmacy NCPDP ID]              varchar(50)  NULL,
        [Pharmacy NPI]                   varchar(50)  NULL,
        [Pharmacy Name]                  varchar(150) NULL,
        [Pharmacy Address 1]             varchar(120) NULL,
        [Pharmacy Address 2]             varchar(120) NULL,
        [Pharmacy City]                  varchar(80)  NULL,
        [Pharmacy State]                 varchar(20)  NULL,
        [Pharmacy Zip]                   varchar(20)  NULL,
        [Pharmacy Phone]                 varchar(30)  NULL,
        [Pharmacy Fax]                   varchar(30)  NULL,
        [Drug GPI]                       varchar(50)  NULL,
        [Drug NDC]                       varchar(50)  NULL,
        [Drug Group Description (GPI 02)] varchar(120) NULL,
        [Drug Name]                      varchar(120) NULL,
        [Drug Name and Strength]         varchar(150) NULL,
        [Drug DEA Code]                  varchar(20)  NULL,
        [Drug Maintenance Code]          varchar(20)  NULL,
        [Generic Indicator Override]     varchar(30)  NULL,
        [DAW Code]                       varchar(30)  NULL,
        [Specialty / Non-Specialty Code] varchar(40)  NULL,
        [Mail / Retail Code]             varchar(40)  NULL,
        [Brand / Generic Code]           varchar(30)  NULL,
        [Total Quantity]                 varchar(50)  NULL,
        [Total Days Supply]              varchar(50)  NULL,
        [Avg Quantity / Day]             varchar(50)  NULL,
        [Total Rxs]                      varchar(50)  NULL,
        [Total Drug Cost]                varchar(50)  NULL,
        [Total Ingredient Cost]          varchar(50)  NULL,
        [Total Dispensing Fee]           varchar(50)  NULL,
        [Total Sales Tax]                varchar(50)  NULL,
        [Total Incentive Fee]            varchar(50)  NULL,
        [Total Plan Paid]                varchar(50)  NULL,
        [Total Member Paid]              varchar(50)  NULL,
        [Total Copay]                    varchar(50)  NULL,
        [Total DAW Penalty]              varchar(50)  NULL,
        [Total Deductible]               varchar(50)  NULL,
        [Loaded At]                      datetime     NOT NULL CONSTRAINT DF_ClaimsData_RHA_LoadedAt DEFAULT GETDATE()
    );
    CREATE UNIQUE INDEX UX_ClaimsData_RHA_Claim
        ON dbo.ClaimsData_RHA ([Client ID], [RxCLAIM Number], [RxCLAIM Sequence Number]);
END
GO
