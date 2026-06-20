import pyodbc
import os
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=" + os.environ["IRX_DB_PWD"] + ";Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN, autocommit=False); c = cn.cursor()

# 1) Add columns (skip if they already exist)
for col in ("last_name", "first_name"):
    c.execute("""
      IF COL_LENGTH('dbo.wellsync_data_June', ?) IS NULL
        EXEC('ALTER TABLE [wellsync_data_June] ADD [""" + col + """] VARCHAR(100) NULL')
    """, col)
cn.commit()

# 2) Parse patient_fullname -> first_name / last_name.
#    last_name = final whitespace-delimited token; first_name = everything before it.
c.execute("""
WITH fn AS (
  SELECT id_tmp = (SELECT 1), *,
         clean = LTRIM(RTRIM(patient_fullname))
  FROM wellsync_data_June
)
UPDATE w
  SET last_name = CASE WHEN CHARINDEX(' ', LTRIM(RTRIM(patient_fullname))) = 0
                       THEN LTRIM(RTRIM(patient_fullname))
                       ELSE LTRIM(RTRIM(RIGHT(LTRIM(RTRIM(patient_fullname)),
                              CHARINDEX(' ', REVERSE(LTRIM(RTRIM(patient_fullname)))) - 1))) END,
      first_name = CASE WHEN CHARINDEX(' ', LTRIM(RTRIM(patient_fullname))) = 0
                        THEN NULL
                        ELSE LTRIM(RTRIM(LEFT(LTRIM(RTRIM(patient_fullname)),
                               LEN(LTRIM(RTRIM(patient_fullname)))
                               - CHARINDEX(' ', REVERSE(LTRIM(RTRIM(patient_fullname))))))) END
FROM wellsync_data_June w
""")
print("rows name-parsed:", c.rowcount)
cn.commit()

# 3) Clear prior match results, then re-match using the new columns.
c.execute("UPDATE wellsync_data_June SET memberid = NULL, GroupName = NULL")
cn.commit()

c.execute("""
WITH elig AS (
  SELECT UPPER(LTRIM(RTRIM(FIRST_NAME))) fn, UPPER(LTRIM(RTRIM(LAST_NAME))) ln,
         TRY_CONVERT(date, DATE_OF_BIRTH, 101) dob, MEMBER_ID, GroupName,
         TRY_CONVERT(date, MEMBER_FROM_DATE, 101) frm
  FROM vw_eligibility
),
ranked AS (
  SELECT fn, ln, dob, MEMBER_ID, GroupName,
    ROW_NUMBER() OVER (PARTITION BY fn, ln, dob
      ORDER BY CASE WHEN frm IS NOT NULL THEN 0 ELSE 1 END, frm DESC, MEMBER_ID DESC) rn
  FROM elig WHERE dob IS NOT NULL
)
UPDATE w SET w.memberid = r.MEMBER_ID, w.GroupName = r.GroupName
FROM wellsync_data_June w
JOIN ranked r
  ON r.rn = 1
 AND r.fn  = UPPER(LTRIM(RTRIM(w.first_name)))
 AND r.ln  = UPPER(LTRIM(RTRIM(w.last_name)))
 AND r.dob = TRY_CONVERT(date, w.patient_dob)
""")
print("rows matched (using parsed columns):", c.rowcount)
cn.commit()

# 4) Report
c.execute("SELECT COUNT(*) FROM wellsync_data_June WHERE memberid IS NOT NULL")
print("total rows populated:", c.fetchone()[0])
c.execute("SELECT COUNT(DISTINCT patient_fullname + '|' + patient_dob) FROM wellsync_data_June WHERE memberid IS NOT NULL")
print("distinct people populated:", c.fetchone()[0])
c.execute("SELECT GroupName, COUNT(*) FROM wellsync_data_June WHERE memberid IS NOT NULL GROUP BY GroupName ORDER BY COUNT(*) DESC")
print("group breakdown:"); [print("   ", r[0], r[1]) for r in c.fetchall()]
print("sample parsed names:")
c.execute("SELECT TOP 6 patient_fullname, first_name, last_name, memberid, GroupName FROM wellsync_data_June")
[print("   ", tuple(r)) for r in c.fetchall()]
cn.close()
