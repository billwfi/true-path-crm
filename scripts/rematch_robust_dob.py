import pyodbc
import os
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=" + os.environ["IRX_DB_PWD"] + ";Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN, autocommit=False); c = cn.cursor()

# How many eligibility DOBs only parse via ISO (style 23), i.e. were missed before?
c.execute("""
  SELECT
    SUM(CASE WHEN TRY_CONVERT(date,DATE_OF_BIRTH,101) IS NOT NULL THEN 1 ELSE 0 END) AS mdy,
    SUM(CASE WHEN TRY_CONVERT(date,DATE_OF_BIRTH,101) IS NULL
             AND TRY_CONVERT(date,DATE_OF_BIRTH,23)  IS NOT NULL THEN 1 ELSE 0 END) AS iso_only,
    SUM(CASE WHEN COALESCE(TRY_CONVERT(date,DATE_OF_BIRTH,101),TRY_CONVERT(date,DATE_OF_BIRTH,23)) IS NULL
             THEN 1 ELSE 0 END) AS unparseable
  FROM vw_eligibility
""")
print("eligibility DOB formats (mdy, iso_only, unparseable):", c.fetchone())

# Reset and re-match with robust DOB parsing on BOTH sides; active-coverage tie-break.
c.execute("UPDATE wellsync_data_June SET memberid = NULL, GroupName = NULL")
cn.commit()

c.execute("""
WITH elig AS (
  SELECT UPPER(LTRIM(RTRIM(FIRST_NAME))) fn, UPPER(LTRIM(RTRIM(LAST_NAME))) ln,
         COALESCE(TRY_CONVERT(date,DATE_OF_BIRTH,101),TRY_CONVERT(date,DATE_OF_BIRTH,23)) dob,
         MEMBER_ID, GroupName,
         COALESCE(TRY_CONVERT(date,MEMBER_FROM_DATE,101),TRY_CONVERT(date,MEMBER_FROM_DATE,23)) frm
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
 AND r.dob = COALESCE(TRY_CONVERT(date,w.patient_dob,23),TRY_CONVERT(date,w.patient_dob,101))
""")
print("rows matched:", c.rowcount)
cn.commit()

c.execute("SELECT COUNT(*) FROM wellsync_data_June WHERE memberid IS NOT NULL")
print("total rows populated:", c.fetchone()[0])
c.execute("SELECT COUNT(DISTINCT first_name+'|'+last_name+'|'+patient_dob) FROM wellsync_data_June WHERE memberid IS NOT NULL")
print("distinct people populated:", c.fetchone()[0])
c.execute("SELECT GroupName, COUNT(*) FROM wellsync_data_June WHERE memberid IS NOT NULL GROUP BY GroupName ORDER BY COUNT(*) DESC")
print("group breakdown:"); [print("   ", r[0], r[1]) for r in c.fetchall()]
c.execute("SELECT DISTINCT first_name,last_name,patient_dob,memberid,GroupName FROM wellsync_data_June WHERE last_name LIKE '%Gallego%'")
print("Gallegos now:"); [print("   ", tuple(r)) for r in c.fetchall()]
cn.close()
