-- 021_gregg_member_key_remap.sql
-- One-time remediation: rekey Gregg County's legacy eligibility rows.
--
-- Background
--   dbo.Eligibility holds two generations of member id for CARRIER 366696:
--     735 rows keyed on a 9-char shared subscriber SSN (one id covers up to 7
--         family members, so it does not identify a person at all)
--      35 rows keyed on the 16-char BCBS MEMBER_NUMBER
--   Neither joins to ClaimsData_GreggCounty, which keys on family id + person
--   code (11 chars) -- 0 of 330 claim patients matched before this change.
--
--   The canonical form, matching City of McAllen and the claims feed, is
--   FAMILY_ID (9) + PERSON_CODE (2), where the subscriber is person code 00.
--   Derived from the BCBS file that is:
--       SUBSTRING(MEMBER_NUMBER,4,9)
--     + CASE WHEN RIGHT(MEMBER_NUMBER,4)='0001' THEN '00' ELSE RIGHT(MEMBER_NUMBER,2) END
--   Validated against claims: this rule matches 328 of 329 claim patients;
--   MEMBER_NUMBER as-is matched 67.
--
-- Why this must run before the feed
--   reconcile_eligibility keys on CARRIER + MEMBER_ID. Left alone, the first run
--   would find none of the 735 legacy members in the file, inactivate all of
--   them, and insert 733 "new" members -- churning the whole roster.
--
-- Matching
--   Legacy rows are matched to the staged roster on last name + first name +
--   DOB: 684 match uniquely, 0 ambiguously, 0 collide on the resulting key.
--   The 51 unmatched rows are left as-is and recorded in the audit table; they
--   are members no longer in the file and the feed will inactivate them
--   normally.
--
-- Reversible: dbo.Eligibility_GreggKeyRemap_Backup holds the full before-image.
--
-- PRECONDITION: dbo.Eligibility_GreggCounty must hold the current roster
-- (stage 1 loaded) before running this.
--
-- Run: node scripts/run-sql.js netlify/database/sqlserver/021_gregg_member_key_remap.sql

SET NOCOUNT ON;
GO

IF NOT EXISTS (SELECT 1 FROM dbo.Eligibility_GreggCounty WHERE LEN(MEMBER_NUMBER) = 16)
    THROW 50002, 'Eligibility_GreggCounty is not loaded; run stage 1 before the remap.', 1;
GO

-- ── Before-image ────────────────────────────────────────────────────────────
IF OBJECT_ID('dbo.Eligibility_GreggKeyRemap_Backup', 'U') IS NULL
    SELECT * INTO dbo.Eligibility_GreggKeyRemap_Backup
      FROM dbo.Eligibility
     WHERE CARRIER = '366696' AND LEN(MEMBER_ID) = 9;
GO

-- ── Audit of every legacy row and what happened to it ───────────────────────
IF OBJECT_ID('dbo.Eligibility_GreggKeyRemap_Audit', 'U') IS NULL
BEGIN
    CREATE TABLE dbo.Eligibility_GreggKeyRemap_Audit (
        old_member_id varchar(50)  NULL,
        new_member_id varchar(50)  NULL,
        last_name     varchar(50)  NULL,
        first_name    varchar(50)  NULL,
        date_of_birth varchar(50)  NULL,
        outcome       varchar(20)  NOT NULL,   -- Remapped | Unmatched
        remapped_at   datetime     NOT NULL CONSTRAINT DF_GreggRemap_At DEFAULT GETDATE()
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM dbo.Eligibility_GreggKeyRemap_Audit)
BEGIN
    WITH roster AS (
        SELECT SUBSTRING(MEMBER_NUMBER, 4, 9)
             + CASE WHEN RIGHT(MEMBER_NUMBER, 4) = '0001' THEN '00'
                    ELSE RIGHT(MEMBER_NUMBER, 2) END          AS new_id,
               UPPER(LTRIM(RTRIM(MEMBER_LASTNAME)))           AS ln,
               UPPER(LTRIM(RTRIM(MEMBER_FIRSTNAME)))          AS fn,
               TRY_CONVERT(date, MEMBER_DOB)                  AS dob
          FROM dbo.Eligibility_GreggCounty
         WHERE LEN(MEMBER_NUMBER) = 16
    ),
    legacy AS (
        SELECT MEMBER_ID, LAST_NAME, FIRST_NAME, DATE_OF_BIRTH,
               UPPER(LTRIM(RTRIM(LAST_NAME)))    AS ln,
               UPPER(LTRIM(RTRIM(FIRST_NAME)))   AS fn,
               TRY_CONVERT(date, DATE_OF_BIRTH)  AS dob
          FROM dbo.Eligibility
         WHERE CARRIER = '366696' AND LEN(MEMBER_ID) = 9
    )
    INSERT INTO dbo.Eligibility_GreggKeyRemap_Audit
          (old_member_id, new_member_id, last_name, first_name, date_of_birth, outcome)
    SELECT l.MEMBER_ID, x.new_id, l.LAST_NAME, l.FIRST_NAME, l.DATE_OF_BIRTH,
           CASE WHEN x.new_id IS NULL THEN 'Unmatched' ELSE 'Remapped' END
      FROM legacy l
      OUTER APPLY (
            SELECT MIN(r.new_id) AS new_id
              FROM roster r
             WHERE r.ln = l.ln AND r.fn = l.fn AND r.dob = l.dob
            HAVING COUNT(DISTINCT r.new_id) = 1      -- unique matches only
      ) x;
END
GO

-- ── Apply ───────────────────────────────────────────────────────────────────
-- Joined on the natural key (old id + name + DOB); verified to produce no
-- duplicate target keys. FAMILY_ID and PERSON_CODE are backfilled so Gregg rows
-- carry the same shape as the AML feeds.
UPDATE e
   SET e.MEMBER_ID      = a.new_member_id,
       e.FAMILY_ID      = LEFT(a.new_member_id, 9),
       e.PERSON_CODE    = RIGHT(a.new_member_id, 2),
       e.LoadUpdateDate = CAST(GETDATE() AS date)
  FROM dbo.Eligibility e
  JOIN dbo.Eligibility_GreggKeyRemap_Audit a
    ON a.outcome        = 'Remapped'
   AND e.CARRIER        = '366696'
   AND e.MEMBER_ID      = a.old_member_id
   AND ISNULL(e.LAST_NAME, '')     = ISNULL(a.last_name, '')
   AND ISNULL(e.FIRST_NAME, '')    = ISNULL(a.first_name, '')
   AND ISNULL(e.DATE_OF_BIRTH, '') = ISNULL(a.date_of_birth, '')
 WHERE LEN(e.MEMBER_ID) = 9;
GO
