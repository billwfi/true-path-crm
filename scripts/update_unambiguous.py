import pyodbc
import os
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=" + os.environ["IRX_DB_PWD"] + ";Encrypt=yes;TrustServerCertificate=yes;")
ELIG = """
  SELECT UPPER(LTRIM(RTRIM(FIRST_NAME))) fn, UPPER(LTRIM(RTRIM(LAST_NAME))) ln,
         TRY_CONVERT(date, DATE_OF_BIRTH, 101) dob, MEMBER_ID, GroupName
  FROM vw_eligibility
"""
cn = pyodbc.connect(CONN, autocommit=False); c = cn.cursor()
c.execute(f"""
  WITH elig AS ({ELIG}),
  uniq AS (
    SELECT fn, ln, dob, MIN(MEMBER_ID) MEMBER_ID, MIN(GroupName) GroupName
    FROM elig WHERE dob IS NOT NULL
    GROUP BY fn, ln, dob
    HAVING COUNT(DISTINCT MEMBER_ID) = 1 AND COUNT(DISTINCT GroupName) = 1
  )
  UPDATE w SET w.memberid = u.MEMBER_ID, w.GroupName = u.GroupName
  FROM wellsync_data_June w
  JOIN uniq u
    ON u.fn  = UPPER(LTRIM(RTRIM(JSON_VALUE(w.patient,'$.first_name'))))
   AND u.ln  = UPPER(LTRIM(RTRIM(JSON_VALUE(w.patient,'$.last_name'))))
   AND u.dob = TRY_CONVERT(date, w.patient_dob)
""")
print("rows updated (unambiguous):", c.rowcount)
cn.commit()
c.execute("SELECT COUNT(*) FROM wellsync_data_June WHERE memberid IS NOT NULL")
print("rows now populated:", c.fetchone()[0])
c.execute("SELECT GroupName, COUNT(*) FROM wellsync_data_June WHERE memberid IS NOT NULL GROUP BY GroupName")
[print("   group:", r[0], r[1]) for r in c.fetchall()]
cn.close()
