import pyodbc
import os
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=" + os.environ["IRX_DB_PWD"] + ";Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN); c = cn.cursor()
for ln, fn in [("CRUM","SHARON"), ("BURTON","KADEIM"), ("LEA","KRISTY")]:
    print(f"=== {fn} {ln} ===")
    c.execute("""
      SELECT MEMBER_ID, GroupName, [GROUP], ACCOUNT, MEMBER_FROM_DATE, MEMBER_THRU_DATE, LoadUpdateDate
      FROM vw_eligibility
      WHERE UPPER(LTRIM(RTRIM(LAST_NAME)))=? AND UPPER(LTRIM(RTRIM(FIRST_NAME)))=?
      ORDER BY MEMBER_FROM_DATE
    """, ln, fn)
    for r in c.fetchall():
        print("   ", tuple(r))
cn.close()
