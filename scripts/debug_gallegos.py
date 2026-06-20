import pyodbc
import os
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=" + os.environ["IRX_DB_PWD"] + ";Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN); c = cn.cursor()

print("=== wellsync rows for Gallegos ===")
c.execute("""
  SELECT DISTINCT first_name, last_name, patient_dob,
         LEN(first_name) lf, LEN(last_name) ll,
         TRY_CONVERT(date, patient_dob) dobconv
  FROM wellsync_data_June WHERE last_name LIKE '%Gallego%'
""")
for r in c.fetchall(): print("   ", tuple(r))

print("\n=== vw_eligibility rows matching first MAXIMO or last GALLEGOS ===")
c.execute("""
  SELECT FIRST_NAME, LAST_NAME, DATE_OF_BIRTH,
         LEN(FIRST_NAME) lf, LEN(LAST_NAME) ll,
         TRY_CONVERT(date, DATE_OF_BIRTH, 101) dob101,
         TRY_CONVERT(date, DATE_OF_BIRTH) dobdef,
         MEMBER_ID, GroupName
  FROM vw_eligibility
  WHERE LAST_NAME LIKE '%GALLEGO%' OR FIRST_NAME LIKE '%MAXIMO%'
""")
rows = c.fetchall()
print("count:", len(rows))
for r in rows: print("   ", tuple(r))

print("\n=== exact normalized-key comparison ===")
c.execute("""
  SELECT TOP 5 '[' + UPPER(LTRIM(RTRIM(first_name))) + ']' fk,
               '[' + UPPER(LTRIM(RTRIM(last_name)))  + ']' lk,
               TRY_CONVERT(date, patient_dob) dob
  FROM wellsync_data_June WHERE last_name LIKE '%Gallego%'
""")
for r in c.fetchall(): print("   ws:", tuple(r))
c.execute("""
  SELECT '[' + UPPER(LTRIM(RTRIM(FIRST_NAME))) + ']' fk,
         '[' + UPPER(LTRIM(RTRIM(LAST_NAME)))  + ']' lk,
         TRY_CONVERT(date, DATE_OF_BIRTH, 101) dob
  FROM vw_eligibility WHERE LAST_NAME LIKE '%GALLEGO%'
""")
for r in c.fetchall(): print("   elig:", tuple(r))
cn.close()
