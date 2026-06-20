import pyodbc
import os
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=" + os.environ["IRX_DB_PWD"] + ";Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN); c = cn.cursor()
for label, where in [
    ("LEOPARDI (Brett)",  "LAST_NAME LIKE '%LEOPARDI%'"),
    ("SPANDORF (Jason)",  "LAST_NAME LIKE '%SPANDORF%'"),
    ("TYSON (Lauren)",    "LAST_NAME LIKE '%TYSON%' AND FIRST_NAME LIKE 'LAUREN%'"),
    ("LANE (Lauren) via shared email", "EMail_Address LIKE '%brae0104%' OR (LAST_NAME='LANE' AND FIRST_NAME LIKE 'LAUREN%')"),
]:
    print(f"=== {label} ===")
    c.execute(f"""SELECT FIRST_NAME, LAST_NAME, DATE_OF_BIRTH, MEMBER_ID, GroupName, EMail_Address
                  FROM vw_eligibility WHERE {where}""")
    rows = c.fetchall()
    print("  found:", len(rows))
    for r in rows: print("   ", tuple(r))
cn.close()
