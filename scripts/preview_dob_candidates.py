import pyodbc
import os
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=" + os.environ["IRX_DB_PWD"] + ";Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN); c = cn.cursor()
DOB = "COALESCE(TRY_CONVERT(date,DATE_OF_BIRTH,101),TRY_CONVERT(date,DATE_OF_BIRTH,23))"

c.execute("""SELECT DISTINCT first_name,last_name,patient_dob
             FROM wellsync_data_June WHERE memberid IS NULL ORDER BY last_name,first_name""")
people = c.fetchall()
for p in people:
    fn, ln, dob = p
    c.execute(f"""
      SELECT FIRST_NAME, LAST_NAME, MEMBER_ID, GroupName
      FROM vw_eligibility
      WHERE {DOB} = TRY_CONVERT(date, ?, 23)
      ORDER BY LAST_NAME, FIRST_NAME
    """, dob)
    cands = c.fetchall()
    tag = "  <-- candidates" if cands else ""
    print(f"WS: {fn} | {ln} | {dob}{tag}")
    for e in cands:
        print(f"      elig: {e[0]} | {e[1]} | {e[2]} | {e[3]}")
cn.close()
