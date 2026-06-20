import pyodbc
import os
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=" + os.environ["IRX_DB_PWD"] + ";Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN, autocommit=False); c = cn.cursor()
DOB_E = "COALESCE(TRY_CONVERT(date,DATE_OF_BIRTH,101),TRY_CONVERT(date,DATE_OF_BIRTH,23))"

# For still-unmatched rows, re-split patient_fullname as:
#   first name = first token, last name = everything after the first token.
# Match elig on that first/last + DOB. Active-coverage tie-break.
c.execute(f"""
WITH ws AS (
  SELECT patient_email, patient_dob,
         clean = LTRIM(RTRIM(patient_fullname))
  FROM wellsync_data_June WHERE memberid IS NULL
),
ws2 AS (
  SELECT *,
    ft  = UPPER(LEFT(clean, CHARINDEX(' ', clean) - 1)),
    rem = UPPER(LTRIM(SUBSTRING(clean, CHARINDEX(' ', clean) + 1, 200)))
  FROM ws WHERE CHARINDEX(' ', clean) > 0
),
elig AS (
  SELECT UPPER(LTRIM(RTRIM(FIRST_NAME))) fn, UPPER(LTRIM(RTRIM(LAST_NAME))) ln,
         {DOB_E} dob, MEMBER_ID, GroupName,
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
JOIN ws2 s ON s.patient_email = w.patient_email AND s.patient_dob = w.patient_dob
JOIN ranked r ON r.rn = 1 AND r.fn = s.ft AND r.ln = s.rem
            AND r.dob = COALESCE(TRY_CONVERT(date,w.patient_dob,23),TRY_CONVERT(date,w.patient_dob,101))
WHERE w.memberid IS NULL
""")
print("compound-name rows matched:", c.rowcount)
cn.commit()

c.execute("SELECT COUNT(*) FROM wellsync_data_June WHERE memberid IS NOT NULL")
print("total rows populated:", c.fetchone()[0])
c.execute("SELECT COUNT(DISTINCT first_name+'|'+last_name+'|'+patient_dob) FROM wellsync_data_June WHERE memberid IS NOT NULL")
print("distinct people populated:", c.fetchone()[0])
c.execute("SELECT GroupName, COUNT(*) FROM wellsync_data_June WHERE memberid IS NOT NULL GROUP BY GroupName ORDER BY COUNT(*) DESC")
print("group breakdown:"); [print("   ", r[0], r[1]) for r in c.fetchall()]
c.execute("""SELECT DISTINCT patient_fullname, memberid, GroupName FROM wellsync_data_June
   WHERE patient_fullname IN ('Nitzaliz P Garcia','ESTHER HERRERA MARTINEZ','Jose Camperos Rojas','CHRISTIAN WILLIAMS ZIMMERMAN')""")
print("compound names now:"); [print("   ", tuple(r)) for r in c.fetchall()]
c.execute("SELECT COUNT(*) FROM wellsync_data_June WHERE memberid IS NULL")
print("rows still unmatched:", c.fetchone()[0])
cn.close()
