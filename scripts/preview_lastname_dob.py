import pyodbc
import os
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=" + os.environ["IRX_DB_PWD"] + ";Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN); c = cn.cursor()
# Of the still-unmatched people, how many match eligibility on LAST NAME + DOB only?
c.execute("""
WITH un AS (
  SELECT DISTINCT first_name, last_name, patient_dob,
         UPPER(LTRIM(RTRIM(last_name))) ln, TRY_CONVERT(date, patient_dob) dob
  FROM wellsync_data_June WHERE memberid IS NULL
),
elig AS (
  SELECT UPPER(LTRIM(RTRIM(LAST_NAME))) ln, UPPER(LTRIM(RTRIM(FIRST_NAME))) efn,
         TRY_CONVERT(date, DATE_OF_BIRTH, 101) dob, MEMBER_ID, GroupName
  FROM vw_eligibility
)
SELECT un.first_name, un.last_name, un.patient_dob,
       (SELECT TOP 1 efn FROM elig e WHERE e.ln=un.ln AND e.dob=un.dob) elig_first,
       (SELECT COUNT(DISTINCT MEMBER_ID) FROM elig e WHERE e.ln=un.ln AND e.dob=un.dob) mids
FROM un
WHERE EXISTS (SELECT 1 FROM elig e WHERE e.ln=un.ln AND e.dob=un.dob)
ORDER BY un.last_name
""")
rows = c.fetchall()
print("unmatched people that WOULD match on last_name + DOB:", len(rows))
for r in rows:
    print(f"   ws=({r.first_name} {r.last_name} {r.patient_dob})  elig_first={r.elig_first}  member_ids={r.mids}")
cn.close()
