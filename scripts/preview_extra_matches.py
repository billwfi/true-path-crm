import pyodbc
import os
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=" + os.environ["IRX_DB_PWD"] + ";Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN); c = cn.cursor()

DOB = "COALESCE(TRY_CONVERT(date,DATE_OF_BIRTH,101),TRY_CONVERT(date,DATE_OF_BIRTH,23))"

print("=== A) EMAIL matches for unmatched (with DOB cross-check) ===")
c.execute(f"""
SELECT w.first_name, w.last_name, w.patient_dob, w.patient_email,
       e.FIRST_NAME, e.LAST_NAME, e.DATE_OF_BIRTH, e.MEMBER_ID, e.GroupName,
       CASE WHEN {DOB} = TRY_CONVERT(date,w.patient_dob,23) THEN 'DOB MATCH' ELSE 'DOB DIFF' END dobchk
FROM (SELECT DISTINCT first_name,last_name,patient_dob,patient_email
      FROM wellsync_data_June WHERE memberid IS NULL) w
JOIN vw_eligibility e
  ON LOWER(LTRIM(RTRIM(e.EMail_Address))) = LOWER(LTRIM(RTRIM(w.patient_email)))
 AND e.EMail_Address IS NOT NULL AND LTRIM(RTRIM(e.EMail_Address)) <> ''
ORDER BY w.last_name
""")
rows = c.fetchall()
print("email-match candidate rows:", len(rows))
for r in rows: print("   ", tuple(r))

print("\n=== B) Alternate name-split candidates (DOB + a shared surname token) ===")
# For each unmatched person, find eligibility rows with same DOB whose LAST_NAME
# equals ANY token of the wellsync fullname, OR whose FIRST_NAME = wellsync first token.
c.execute(f"""
SELECT w.first_name, w.last_name, w.patient_dob,
       e.FIRST_NAME, e.LAST_NAME, e.DATE_OF_BIRTH, e.MEMBER_ID, e.GroupName
FROM (SELECT DISTINCT first_name,last_name,patient_dob,
             LTRIM(RTRIM(first_name)) f1, TRY_CONVERT(date,patient_dob,23) dob
      FROM wellsync_data_June WHERE memberid IS NULL) w
JOIN vw_eligibility e
  ON {DOB} = w.dob
 AND (
      UPPER(LTRIM(RTRIM(e.LAST_NAME)))  = UPPER(w.last_name)
   OR UPPER(LTRIM(RTRIM(e.FIRST_NAME))) = UPPER(w.first_name)
   OR UPPER(LTRIM(RTRIM(e.LAST_NAME)))  = UPPER(REVERSE(LEFT(REVERSE(LTRIM(RTRIM(w.first_name))),
                                              CHARINDEX(' ',REVERSE(LTRIM(RTRIM(w.first_name))))+0)))
     )
ORDER BY w.last_name
""")
rows = c.fetchall()
print("alt-split candidate rows:", len(rows))
for r in rows: print("   ws=(%s | %s | %s)  elig=(%s | %s | %s)  %s  %s" %
                      (r[0], r[1], r[2], r[4], r[5], r[6], r[7], r[8]))
cn.close()
