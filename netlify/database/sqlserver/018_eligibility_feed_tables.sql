-- 018_eligibility_feed_tables.sql
-- Staging tables + client records for the five eligibility feeds migrating off SSIS:
--   City of McAllen, City of Mission, Gregg County, Smith County, UOP.
--
-- Three source layouts, not five:
--   A "AML/PSI"  (57 cols, matches dbo.Eligibility 1:1) -> McAllen, Smith County
--   B "BCBS"     (48 cols)                              -> Gregg County, City of Mission
--   C "WellDyne" (26 cols, CSV)                         -> UOP
--
-- McAllen (dbo.Eligibility_CityofMcAllen) and Gregg (dbo.Eligibility_GreggCounty)
-- already exist, so the two new Excel staging tables are cloned from them -- the
-- file headers match those tables column-for-column, which keeps the column maps
-- a straight identity mapping.
--
-- Run: node scripts/run-sql.js netlify/database/sqlserver/018_eligibility_feed_tables.sql

-- ── B: City of Mission (clone of the Gregg County BCBS layout) ───────────────
IF OBJECT_ID('dbo.Eligibility_CityofMission', 'U') IS NULL
    SELECT TOP 0 * INTO dbo.Eligibility_CityofMission FROM dbo.Eligibility_GreggCounty;
GO

-- ── A: Smith County (clone of the McAllen AML layout) ───────────────────────
IF OBJECT_ID('dbo.Eligibility_SmithCounty', 'U') IS NULL
    SELECT TOP 0 * INTO dbo.Eligibility_SmithCounty FROM dbo.Eligibility_CityofMcAllen;
GO

-- ── C: UOP (WellDyne EligibilityByMember CSV) ───────────────────────────────
-- Source headers carry spaces ("Carrier ID"); staging uses underscored names and
-- Import_Column_Maps bridges the two. Widths follow the varchar(50) convention of
-- the other staging tables.
IF OBJECT_ID('dbo.Eligibility_UOP', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Eligibility_UOP (
        Carrier_ID               varchar(50)  NULL,
        Carrier_Name             varchar(50)  NULL,
        Account_ID               varchar(50)  NULL,
        Account_Name             varchar(50)  NULL,
        Group_ID                 varchar(50)  NULL,
        Group_Name               varchar(150) NULL,
        Member_ID                varchar(50)  NULL,
        Family_ID                varchar(50)  NULL,
        Person_Code              varchar(50)  NULL,
        Relationship_Code        varchar(50)  NULL,
        Member_From_Date         varchar(50)  NULL,
        Member_Thru_Date         varchar(50)  NULL,
        Member_First_Name        varchar(50)  NULL,
        Member_Last_Name         varchar(50)  NULL,
        Member_DOB               varchar(50)  NULL,
        Member_Gender            varchar(50)  NULL,
        Member_Address_1         varchar(100) NULL,
        Member_Address_2         varchar(100) NULL,
        Member_City              varchar(50)  NULL,
        Member_State             varchar(50)  NULL,
        Member_Zip_Code          varchar(50)  NULL,
        Member_Phone_Number      varchar(50)  NULL,
        Alternate_Insurance_ID   varchar(50)  NULL,
        Alternate_Insurance_Code varchar(50)  NULL,
        [New]                    varchar(10)  NULL,
        Termed                   varchar(10)  NULL
    );
END
GO

-- ── Client records ──────────────────────────────────────────────────────────
-- irx_client_id IS the CARRIER value used to scope dbo.Eligibility and the
-- ClaimsData_* tables. Values are taken from the source files and follow the
-- existing convention (City of McAllen = PSI3604, Gregg County = 366696).
--   City of Mission  077803  (ACCOUNT_NUMBER in the BCBS file)
--   Smith County     PSI1022 (CARRIER in the AML file)
--   UOP              RWTFMH  (Carrier ID in the WellDyne file; CoreSource / Pacific Benefits)
IF NOT EXISTS (SELECT 1 FROM dbo.tp_clients WHERE irx_client_id = '077803')
    INSERT INTO dbo.tp_clients (name, irx_client_id, active, import_file_path)
    VALUES ('City of Mission', '077803', 1, '/InternationalRx/CityOfMission');
GO

IF NOT EXISTS (SELECT 1 FROM dbo.tp_clients WHERE irx_client_id = 'PSI1022')
    INSERT INTO dbo.tp_clients (name, irx_client_id, active, import_file_path)
    VALUES ('Smith County', 'PSI1022', 1, '/InternationalRx/SmithCounty');
GO

IF NOT EXISTS (SELECT 1 FROM dbo.tp_clients WHERE irx_client_id = 'RWTFMH')
    INSERT INTO dbo.tp_clients (name, irx_client_id, active, import_file_path)
    VALUES ('UOP', 'RWTFMH', 1, '/InternationalRx/UOP');
GO

-- Backfill the import path for the two clients that already existed.
UPDATE dbo.tp_clients SET import_file_path = '/InternationalRx/CityOfMcAllen'
 WHERE irx_client_id = 'PSI3604' AND (import_file_path IS NULL OR import_file_path = '');
GO

UPDATE dbo.tp_clients SET import_file_path = '/InternationalRx/GreggCounty'
 WHERE irx_client_id = '366696' AND (import_file_path IS NULL OR import_file_path = '');
GO
