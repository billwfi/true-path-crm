// Derived-column enrichment for dbo.wellsync_data_June.
//
// The WellSync CSV supplies 24 raw columns. Five more columns on the table are
// DERIVED and are not present in the file:
//
//   last_name / first_name  <- split from patient_fullname
//   medication              <- keyword from service_service_name
//   memberid / GroupName    <- matched against dbo.vw_eligibility
//
// Historically these were filled by a manual step after loading, so any rows
// added without it were left blank (see the June 2026 batch: 39 of 396 rows).
// Both the import API and scripts/backfill_wellsync_enrichment.js call ENRICH_SQL
// so the two paths cannot drift.
//
// Every statement is scoped to rows that are still blank, so re-running is safe
// and already-enriched rows are never overwritten.

const TABLE = 'dbo.wellsync_data_June';

// patient_fullname -> last token = last_name, everything before it = first_name.
// Verified against all 357 previously-enriched rows: reproduces them exactly.
const FULL = `LTRIM(RTRIM(patient_fullname))`;
const LAST = `LTRIM(RTRIM(REVERSE(LEFT(REVERSE(${FULL}), CHARINDEX(' ', REVERSE(${FULL}) + ' ') - 1))))`;
const FIRST = `LTRIM(RTRIM(LEFT(${FULL}, LEN(${FULL}) - CHARINDEX(' ', REVERSE(${FULL}) + ' ') + 1)))`;

// Names + medication, both derived from the row's own CSV fields.
const SQL_NAMES_MEDICATION = `
UPDATE t
   SET last_name  = ${LAST},
       first_name = ${FIRST},
       medication = CASE
         WHEN service_service_name LIKE '%Tirzepatide%' THEN 'Tirzepatide'
         WHEN service_service_name LIKE '%Semaglutide%' THEN 'Semaglutide'
       END
  FROM ${TABLE} t
 WHERE (t.last_name IS NULL OR t.last_name = '')
   AND t.patient_fullname IS NOT NULL AND t.patient_fullname <> ''`;

// memberid / GroupName from eligibility, matched on last + first + DOB.
// A person can hold several eligibility rows (e.g. a current record plus a stale
// one), so the match is ordered deterministically: prefer a row with a
// MEMBER_THRU_DATE (the live coverage record), then the latest one, then
// MEMBER_ID so the result is stable across runs rather than arbitrary.
const SQL_ELIGIBILITY = `
UPDATE t
   SET memberid  = e.MEMBER_ID,
       GroupName = e.GroupName
  FROM ${TABLE} t
 CROSS APPLY (
   SELECT TOP 1 v.MEMBER_ID, v.GroupName
     FROM dbo.vw_eligibility v
    WHERE UPPER(LTRIM(RTRIM(v.LAST_NAME)))  = UPPER(${LAST})
      AND UPPER(LTRIM(RTRIM(v.FIRST_NAME))) = UPPER(${FIRST})
      AND TRY_CONVERT(date, v.DATE_OF_BIRTH) = TRY_CONVERT(date, t.patient_dob)
    ORDER BY CASE WHEN v.MEMBER_THRU_DATE IS NULL THEN 1 ELSE 0 END,
             TRY_CONVERT(date, v.MEMBER_THRU_DATE) DESC,
             v.MEMBER_ID
 ) e
 WHERE (t.GroupName IS NULL OR t.GroupName = '')
   AND t.patient_fullname IS NOT NULL AND t.patient_fullname <> ''`;

// Carry-forward for the rows eligibility could not match.
//
// These patients recur every month, so the same person is usually already
// present and enriched from an earlier load. The eligibility join misses them
// only because their eligibility record has DATE_OF_BIRTH = NULL, so the DOB
// equality above can never be true.
//
// Copying from the person's own earlier rows is safe: the source is required to
// be unanimous (one GroupName and one memberid across every enriched row for
// that name + DOB), so an ambiguous history fills nothing. Verified on the June
// 2026 batch — for all five of these rows where eligibility also matched on name
// alone, the carried value equalled the eligibility value exactly.
const SQL_SIBLING_CARRY = `
UPDATE t
   SET memberid  = s.memberid,
       GroupName = s.GroupName
  FROM ${TABLE} t
 CROSS APPLY (
   SELECT MAX(p.GroupName) AS GroupName, MAX(p.memberid) AS memberid
     FROM ${TABLE} p
    WHERE p.patient_fullname = t.patient_fullname
      AND ISNULL(p.patient_dob, '') = ISNULL(t.patient_dob, '')
      AND p.GroupName IS NOT NULL AND p.GroupName <> ''
   HAVING COUNT(DISTINCT p.GroupName) = 1
      AND COUNT(DISTINCT p.memberid)  = 1
 ) s
 WHERE (t.GroupName IS NULL OR t.GroupName = '')`;

const ENRICH_SQL = [SQL_NAMES_MEDICATION, SQL_ELIGIBILITY, SQL_SIBLING_CARRY];

// Run all three passes in order; returns rows touched by each.
// Eligibility runs before the carry-forward so a real match always wins.
async function enrich(mssql) {
  const names = await mssql(SQL_NAMES_MEDICATION);
  const elig = await mssql(SQL_ELIGIBILITY);
  const carry = await mssql(SQL_SIBLING_CARRY);
  return {
    namesUpdated: names.rowsAffected[0],
    eligUpdated: elig.rowsAffected[0],
    carriedUpdated: carry.rowsAffected[0],
  };
}

module.exports = {
  TABLE, LAST, FIRST,
  SQL_NAMES_MEDICATION, SQL_ELIGIBILITY, SQL_SIBLING_CARRY,
  ENRICH_SQL, enrich,
};
