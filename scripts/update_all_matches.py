import pyodbc
import os
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=" + os.environ["IRX_DB_PWD"] + ";Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN, autocommit=False); c = cn.cursor()

# Rank eligibility per person: active-coverage rows first (MEMBER_FROM_DATE present),
# then most recent coverage start, then member_id desc as a final tiebreak.
c.execute("""
WITH elig AS (
  SELECT
    UPPER(LTRIM(RTRIM(FIRST_NAME))) fn,
    UPPER(LTRIM(RTRIM(LAST_NAME)))  ln,
    TRY_CONVERT(date, DATE_OF_BIRTH, 101) dob,
    MEMBER_ID, GroupName,
    TRY_CONVERT(date, MEMBER_FROM_DATE, 101) frm
  FROM vw_eligibility
),
ranked AS (
  SELECT fn, ln, dob, MEMBER_ID, GroupName,
    ROW_NUMBER() OVER (
      PARTITION BY fn, ln, dob
      ORDER BY CASE WHEN frm IS NOT NULL THEN 0 ELSE 1 END,
               frm DESC, MEMBER_ID DESC
    ) rn
  FROM elig WHERE dob IS NOT NULL
)
UPDATE w SET w.memberid = r.MEMBER_ID, w.GroupName = r.GroupName
FROM wellsync_data_June w
JOIN ranked r
  ON r.rn = 1
 AND r.fn  = UPPER(LTRIM(RTRIM(JSON_VALUE(w.patient,'$.first_name'))))
 AND r.ln  = UPPER(LTRIM(RTRIM(JSON_VALUE(w.patient,'$.last_name'))))
 AND r.dob = TRY_CONVERT(date, w.patient_dob)
""")
print("rows updated (all matches):", c.rowcount)
cn.commit()

c.execute("SELECT COUNT(*) FROM wellsync_data_June WHERE memberid IS NOT NULL")
print("total rows populated:", c.fetchone()[0])
c.execute("""SELECT COUNT(DISTINCT patient_email) FROM wellsync_data_June WHERE memberid IS NOT NULL""")
print("distinct people populated:", c.fetchone()[0])
c.execute("SELECT GroupName, COUNT(*) FROM wellsync_data_June WHERE memberid IS NOT NULL GROUP BY GroupName ORDER BY COUNT(*) DESC")
print("group breakdown:")
[print("   ", r[0], r[1]) for r in c.fetchall()]
# show a couple of the previously-ambiguous people
c.execute("""SELECT DISTINCT patient_fullname, memberid, GroupName FROM wellsync_data_June
             WHERE patient_fullname IN ('SHARON CRUM','KADEIM BURTON','Kristy Lea')""")
print("sample (was ambiguous):")
[print("   ", tuple(r)) for r in c.fetchall()]
cn.close()
