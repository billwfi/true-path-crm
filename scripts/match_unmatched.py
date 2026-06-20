import pyodbc
import os
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=" + os.environ["IRX_DB_PWD"] + ";Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN, autocommit=False); c = cn.cursor()

c.execute("SELECT COUNT(*) FROM wellsync_data_June WHERE memberid IS NULL")
print("unmatched rows before:", c.fetchone()[0])

# Match ONLY on last+first+dob. No coverage date ranges considered at all.
# Among any eligibility ties, pick MAX(MEMBER_ID)/MAX(GroupName) deterministically.
c.execute("""
WITH elig AS (
  SELECT UPPER(LTRIM(RTRIM(FIRST_NAME))) fn, UPPER(LTRIM(RTRIM(LAST_NAME))) ln,
         TRY_CONVERT(date, DATE_OF_BIRTH, 101) dob, MEMBER_ID, GroupName
  FROM vw_eligibility
),
e1 AS (
  SELECT fn, ln, dob, MAX(MEMBER_ID) MEMBER_ID, MAX(GroupName) GroupName
  FROM elig WHERE dob IS NOT NULL GROUP BY fn, ln, dob
)
UPDATE w SET w.memberid = e.MEMBER_ID, w.GroupName = e.GroupName
FROM wellsync_data_June w
JOIN e1 e
  ON e.fn  = UPPER(LTRIM(RTRIM(w.first_name)))
 AND e.ln  = UPPER(LTRIM(RTRIM(w.last_name)))
 AND e.dob = TRY_CONVERT(date, w.patient_dob)
WHERE w.memberid IS NULL
""")
print("new rows matched:", c.rowcount)
cn.commit()

c.execute("SELECT COUNT(*) FROM wellsync_data_June WHERE memberid IS NOT NULL")
print("total rows populated now:", c.fetchone()[0])

print("\nStill-unmatched distinct people (first, last, dob):")
c.execute("""
  SELECT first_name, last_name, patient_dob, patient_email
  FROM wellsync_data_June WHERE memberid IS NULL
  GROUP BY first_name, last_name, patient_dob, patient_email
  ORDER BY last_name, first_name
""")
rows = c.fetchall()
print("count:", len(rows))
for r in rows:
    print("   ", tuple(r))
cn.close()
