-- 019_eligibility_feed_configs.sql
-- Feed configs for the five eligibility imports moving off SSIS, plus the two
-- small framework additions they need.
--
-- Framework additions
--   1. Import_Reconcile_Maps.stage_expression -- a SQL expression evaluated against
--      the staging table instead of a bare column. This is where per-client
--      transforms live (member-key derivation, date normalisation, junk->NULL),
--      so no client needs bespoke Python.
--   2. Import_Configs.stage_filter -- optional WHERE clause applied when reading
--      the staging table (used to drop test records).
--   3. dbo.fn_NormalizeEligDate -- collapses the four date shapes found in the
--      wild into one M/D/YYYY form.
--
-- Run: node scripts/run-sql.js netlify/database/sqlserver/019_eligibility_feed_configs.sql

IF COL_LENGTH('dbo.Import_Reconcile_Maps', 'stage_expression') IS NULL
    ALTER TABLE dbo.Import_Reconcile_Maps ADD stage_expression nvarchar(1000) NULL;
GO

IF COL_LENGTH('dbo.Import_Configs', 'stage_filter') IS NULL
    ALTER TABLE dbo.Import_Configs ADD stage_filter nvarchar(1000) NULL;
GO

-- ── Date normalisation ──────────────────────────────────────────────────────
-- dbo.Eligibility currently holds four incompatible shapes in the same column:
--   ''              (blank, ~14.5k rows)  -> NULL
--   '39-12-31 0:00' (yy-m-d h:mm, ~3.3k)  -> 12/31/2039   <- SSIS wrote Excel's
--                                                            display text
--   '12/31/2039'    (clean, ~3.1k)        -> unchanged
--   '12/31/9999'    (BCBS "no end", 771)  -> unchanged
--   '00-0-1 12:00'  (null date)           -> NULL
-- parse_date_any() in import_worker.py cannot read the yy-m-d shape, so those
-- rows are treated as "no end date". Normalising on load stops the problem
-- spreading; existing rows are deliberately left alone.
CREATE OR ALTER FUNCTION dbo.fn_NormalizeEligDate (@s varchar(50))
RETURNS varchar(10)
AS
BEGIN
    DECLARE @t varchar(50) = LTRIM(RTRIM(ISNULL(@s, '')));
    IF @t = '' RETURN NULL;

    -- Excel's null date, in either rendering.
    IF @t LIKE '00-0-%' OR @t LIKE '0000-00-00%' RETURN NULL;

    -- Strip a trailing time component ('39-12-31 0:00' -> '39-12-31').
    IF CHARINDEX(' ', @t) > 0 SET @t = LEFT(@t, CHARINDEX(' ', @t) - 1);

    DECLARE @d date;

    -- yy-m-d  (two-digit year, no zero padding) -- the corrupt SSIS shape.
    IF @t LIKE '[0-9][0-9]-%-%'
    BEGIN
        SET @d = TRY_CONVERT(date, '20' + @t, 23);
        IF @d IS NULL SET @d = TRY_CONVERT(date, '20' + @t);
    END

    -- Everything else: ISO, then US.
    IF @d IS NULL SET @d = TRY_CONVERT(date, @t, 23);
    IF @d IS NULL SET @d = TRY_CONVERT(date, @t, 101);
    IF @d IS NULL SET @d = TRY_CONVERT(date, @t);
    IF @d IS NULL RETURN NULL;

    RETURN CONVERT(varchar(10), @d, 101);   -- MM/DD/YYYY
END
GO

-- ── Config seeding ──────────────────────────────────────────────────────────
-- All five feeds share the one sftpcloud account. The password ciphertext is
-- copied from an existing config so IMPORT_CRYPT_KEY is never needed here and
-- the secret stays out of source control.
DECLARE @pwd nvarchar(max) = (
    SELECT TOP 1 sftp_password_enc FROM dbo.Import_Configs
     WHERE sftp_password_enc IS NOT NULL AND sftp_host = 'us-east-1.sftpcloud.io'
     ORDER BY id);

IF @pwd IS NULL
    THROW 50001, 'No existing sftpcloud config to copy the encrypted password from.', 1;

DECLARE @feeds TABLE (
    carrier      varchar(20),
    name         nvarchar(400),
    remote_dir   nvarchar(800),
    file_pattern nvarchar(400),
    file_format  nvarchar(40),
    target_table nvarchar(400),
    stage_filter nvarchar(1000)
);

INSERT INTO @feeds VALUES
 ('PSI3604', 'City of McAllen Eligibility',  '/InternationalRx/CityOfMcAllen', 'HRx_PBM_McAllen_Eligibility_AML_*.xls*',   'xlsx', 'dbo.Eligibility_CityofMcAllen', NULL),
 ('PSI1022', 'Smith County Eligibility',     '/InternationalRx/SmithCounty',   'HRx_PBM_SmithCounty_Eligibility_AML_*.xls*','xlsx', 'dbo.Eligibility_SmithCounty',   NULL),
 -- City of Mission ships a live test record that must never reach eligibility.
 ('077803',  'City of Mission Eligibility',  '/InternationalRx/CityOfMission', 'HRx_BCBS_CityofMission_Eligibility_*.xls*','xlsx', 'dbo.Eligibility_CityofMission',
    'MEMBER_LASTNAME <> ''TESTER'' AND MEMBER_FIRSTNAME NOT LIKE ''DO NOT PROCESS%'''),
 ('366696',  'Gregg County Eligibility',     '/InternationalRx/GreggCounty',   'HRx_BCBS_GreggCounty_Eligibility_*.xls*',  'xlsx', 'dbo.Eligibility_GreggCounty',   NULL),
 ('RWTFMH',  'UOP Eligibility',              '/InternationalRx/UOP',           '*EligibilityByMember_*.csv',               'csv',  'dbo.Eligibility_UOP',          NULL);

INSERT INTO dbo.Import_Configs
    (client_id, name, feed_type, sftp_host, sftp_port, sftp_username, sftp_password_enc,
     remote_dir, file_pattern, file_format, delimiter, has_header, header_row,
     stop_on_blank, footer_skip, target_table, reconcile_table, stage_filter,
     truncate_before, after_import, schedule_frequency, schedule_time, schedule_dow, active)
SELECT c.id, f.name, 'Eligibility', 'us-east-1.sftpcloud.io', 22, 'MANAGER', @pwd,
       f.remote_dir, f.file_pattern, f.file_format,
       CASE WHEN f.file_format = 'csv' THEN ',' END,
       1, 1,
       -- Mission/Gregg .xlsx carry ~4,500 blank formatted rows past end-of-data;
       -- without this the staging table fills with empty rows (as it does today).
       1, 0,
       f.target_table, 'dbo.Eligibility', f.stage_filter,
       1, 'leave', 'Weekly', '06:00', 1, 1
  FROM @feeds f
  JOIN dbo.tp_clients c ON c.irx_client_id = f.carrier
 WHERE NOT EXISTS (SELECT 1 FROM dbo.Import_Configs ic WHERE ic.name = f.name);
GO

-- ── Column maps: file header -> staging column ──────────────────────────────
-- Generated from the staging tables. The AML and BCBS headers match their tables
-- name-for-name, so those are an identity map. The UOP CSV uses spaces where the
-- table uses underscores ("Carrier ID" -> Carrier_ID).
INSERT INTO dbo.Import_Column_Maps (config_id, source_column, target_column, ordinal)
SELECT ic.id,
       CASE WHEN ic.file_format = 'csv' THEN REPLACE(col.COLUMN_NAME, '_', ' ') ELSE col.COLUMN_NAME END,
       col.COLUMN_NAME,
       col.ORDINAL_POSITION
  FROM dbo.Import_Configs ic
  JOIN INFORMATION_SCHEMA.COLUMNS col
    ON col.TABLE_SCHEMA = PARSENAME(ic.target_table, 2)
   AND col.TABLE_NAME   = PARSENAME(ic.target_table, 1)
 WHERE ic.feed_type = 'Eligibility'
   AND ic.name IN ('City of McAllen Eligibility', 'Smith County Eligibility',
                   'City of Mission Eligibility', 'Gregg County Eligibility', 'UOP Eligibility')
   AND NOT EXISTS (SELECT 1 FROM dbo.Import_Column_Maps m WHERE m.config_id = ic.id);
GO

-- ── Reconcile maps: staging -> dbo.Eligibility ──────────────────────────────
-- CARRIER is supplied by the worker from tp_clients.irx_client_id, so it is
-- deliberately absent here.

-- Format A (AML/PSI): McAllen, Smith County. Header names already match
-- dbo.Eligibility, so only the date columns need an expression.
DECLARE @amlMap TABLE (stage_col sysname, elig_col sysname, expr nvarchar(1000), ord int);
INSERT INTO @amlMap (stage_col, elig_col, expr, ord) VALUES
 ('ACCOUNT','ACCOUNT',NULL,1), ('GROUP','GROUP',NULL,2), ('MEMBER_ID','MEMBER_ID',NULL,3),
 ('PERSON_CODE','PERSON_CODE',NULL,4), ('RELATIONSHIP_CODE','RELATIONSHIP_CODE',NULL,5),
 ('LAST_NAME','LAST_NAME',NULL,6), ('FIRST_NAME','FIRST_NAME',NULL,7),
 ('MIDDLE_INITIAL','MIDDLE_INITIAL',NULL,8), ('SEX','SEX',NULL,9),
 ('DATE_OF_BIRTH','DATE_OF_BIRTH','dbo.fn_NormalizeEligDate([DATE_OF_BIRTH])',10),
 ('MEMBER_TYPE','MEMBER_TYPE',NULL,11), ('LANGUAGE_CODE','LANGUAGE_CODE',NULL,12),
 ('SOCIAL_SECURITY_NUMBER','SOCIAL_SECURITY_NUMBER',NULL,13),
 ('ADDRESS_1','ADDRESS_1',NULL,14), ('ADDRESS_2','ADDRESS_2',NULL,15),
 ('CITY','CITY',NULL,16), ('STATE','STATE',NULL,17), ('ZIP','ZIP',NULL,18),
 ('COUNTRY','COUNTRY',NULL,19), ('PHONE','PHONE',NULL,20), ('FAMILY_ID','FAMILY_ID',NULL,21),
 ('ORIGINAL_FROM_DATE','ORIGINAL_FROM_DATE','dbo.fn_NormalizeEligDate([ORIGINAL_FROM_DATE])',22),
 ('MEMBER_FROM_DATE','MEMBER_FROM_DATE','dbo.fn_NormalizeEligDate([MEMBER_FROM_DATE])',23),
 ('MEMBER_THRU_DATE','MEMBER_THRU_DATE','dbo.fn_NormalizeEligDate([MEMBER_THRU_DATE])',24),
 ('E-Mail_Address','EMail_Address',NULL,25);

-- Format B (BCBS): Gregg County, City of Mission.
-- MEMBER_ID is derived, not copied. Verified against ClaimsData_GreggCounty:
-- this rule matches 328 of 329 claim patients, where MEMBER_NUMBER as-is matched
-- only 67. Subscribers are person code 00 in claims but sequence 0001 in the file.
DECLARE @bcbsMap TABLE (stage_col sysname, elig_col sysname, expr nvarchar(1000), ord int);
INSERT INTO @bcbsMap (stage_col, elig_col, expr, ord) VALUES
 ('ACCOUNT_NUMBER','ACCOUNT',NULL,1),
 ('GROUP_NUMBER','GROUP',NULL,2),
 ('MEMBER_NUMBER','MEMBER_ID',
   'SUBSTRING([MEMBER_NUMBER],4,9) + CASE WHEN RIGHT([MEMBER_NUMBER],4) = ''0001'' THEN ''00'' ELSE RIGHT([MEMBER_NUMBER],2) END',3),
 ('MEMBER_NUMBER','PERSON_CODE',
   'CASE WHEN RIGHT([MEMBER_NUMBER],4) = ''0001'' THEN ''00'' ELSE RIGHT([MEMBER_NUMBER],2) END',4),
 ('MEMBER_RELATIONSHIP_CODE','RELATIONSHIP_CODE',NULL,5),
 ('MEMBER_LASTNAME','LAST_NAME',NULL,6),
 ('MEMBER_FIRSTNAME','FIRST_NAME',NULL,7),
 ('MEMBER_GENDER','SEX',NULL,8),
 ('MEMBER_DOB','DATE_OF_BIRTH','dbo.fn_NormalizeEligDate([MEMBER_DOB])',9),
 -- BCBS writes the literal 'NOT FOUND' when a dependent has no SSN on file.
 ('MEMBER_SSN','SOCIAL_SECURITY_NUMBER','NULLIF([MEMBER_SSN], ''NOT FOUND'')',10),
 ('SUBSCRIBER_ADDRESS','ADDRESS_1',NULL,11),
 ('SUBSCRIBER_CITY','CITY',NULL,12),
 ('SUBSCRIBER_STATE','STATE',NULL,13),
 ('SUBSCRIBER_ZIPCODE','ZIP',NULL,14),
 ('MEMBER_PHONE','PHONE',NULL,15),
 ('SUBSCRIBER_ID','FAMILY_ID','RIGHT([SUBSCRIBER_ID],9)',16),
 ('MEMBER_ORIGINAL_EFF_DATE','ORIGINAL_FROM_DATE','dbo.fn_NormalizeEligDate([MEMBER_ORIGINAL_EFF_DATE])',17),
 ('MEMBER_EFF_DATE','MEMBER_FROM_DATE','dbo.fn_NormalizeEligDate([MEMBER_EFF_DATE])',18),
 ('MEMBER_CANCEL_DATE','MEMBER_THRU_DATE','dbo.fn_NormalizeEligDate([MEMBER_CANCEL_DATE])',19),
 ('MEMBER_EMAIL','EMail_Address',NULL,20),
 ('MEMBER_STATUS','MEMBER_TYPE',NULL,21);

-- Format C (WellDyne CSV): UOP. 'UN' is this vendor's placeholder for unknown and
-- must not land as literal text.
DECLARE @uopMap TABLE (stage_col sysname, elig_col sysname, expr nvarchar(1000), ord int);
INSERT INTO @uopMap (stage_col, elig_col, expr, ord) VALUES
 ('Account_ID','ACCOUNT',NULL,1),
 ('Group_ID','GROUP',NULL,2),
 ('Member_ID','MEMBER_ID',NULL,3),
 ('Person_Code','PERSON_CODE',NULL,4),
 ('Relationship_Code','RELATIONSHIP_CODE',NULL,5),
 ('Member_Last_Name','LAST_NAME',NULL,6),
 ('Member_First_Name','FIRST_NAME',NULL,7),
 ('Member_Gender','SEX',NULL,8),
 ('Member_DOB','DATE_OF_BIRTH','dbo.fn_NormalizeEligDate([Member_DOB])',9),
 ('Member_Address_1','ADDRESS_1','NULLIF([Member_Address_1], ''UN'')',10),
 ('Member_Address_2','ADDRESS_2','NULLIF([Member_Address_2], ''UN'')',11),
 ('Member_City','CITY','NULLIF([Member_City], ''UN'')',12),
 ('Member_State','STATE','NULLIF([Member_State], ''UN'')',13),
 ('Member_Zip_Code','ZIP','NULLIF([Member_Zip_Code], ''UN'')',14),
 ('Member_Phone_Number','PHONE','NULLIF([Member_Phone_Number], ''UN'')',15),
 ('Family_ID','FAMILY_ID',NULL,16),
 ('Member_From_Date','MEMBER_FROM_DATE','dbo.fn_NormalizeEligDate([Member_From_Date])',17),
 ('Member_Thru_Date','MEMBER_THRU_DATE','dbo.fn_NormalizeEligDate([Member_Thru_Date])',18),
 ('Group_Name','GroupName',NULL,19),
 ('Alternate_Insurance_ID','ALTERNATE_INSURANCE_ID','NULLIF([Alternate_Insurance_ID], ''UN'')',20),
 ('Alternate_Insurance_Code','ALTERNATE_INSURANCE_CODE','NULLIF([Alternate_Insurance_Code], ''UN'')',21);

INSERT INTO dbo.Import_Reconcile_Maps (config_id, stage_column, eligibility_column, stage_expression, ordinal)
SELECT ic.id, m.stage_col, m.elig_col, m.expr, m.ord
  FROM dbo.Import_Configs ic
  CROSS APPLY (
        SELECT * FROM @amlMap  WHERE ic.name IN ('City of McAllen Eligibility', 'Smith County Eligibility')
        UNION ALL
        SELECT * FROM @bcbsMap WHERE ic.name IN ('Gregg County Eligibility', 'City of Mission Eligibility')
        UNION ALL
        SELECT * FROM @uopMap  WHERE ic.name = 'UOP Eligibility'
  ) m
 WHERE ic.name IN ('City of McAllen Eligibility', 'Smith County Eligibility',
                   'City of Mission Eligibility', 'Gregg County Eligibility', 'UOP Eligibility')
   AND NOT EXISTS (SELECT 1 FROM dbo.Import_Reconcile_Maps r WHERE r.config_id = ic.id);
GO
