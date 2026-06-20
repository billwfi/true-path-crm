import sys, pyodbc

import os
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=" + os.environ["IRX_DB_PWD"] + ";"
        "Encrypt=yes;TrustServerCertificate=yes;")

WS = """
  SELECT DISTINCT
    UPPER(LTRIM(RTRIM(JSON_VALUE(patient,'$.first_name')))) fn,
    UPPER(LTRIM(RTRIM(JSON_VALUE(patient,'$.last_name'))))  ln,
    TRY_CONVERT(date, patient_dob) dob
  FROM wellsync_data_June
"""
ELIG = """
  SELECT
    UPPER(LTRIM(RTRIM(FIRST_NAME))) fn,
    UPPER(LTRIM(RTRIM(LAST_NAME)))  ln,
    TRY_CONVERT(date, DATE_OF_BIRTH, 101) dob,
    MEMBER_ID, GroupName
  FROM vw_eligibility
"""

def run():
    do_update = len(sys.argv) > 1 and sys.argv[1] == "--update"
    cn = pyodbc.connect(CONN, autocommit=False)
    c = cn.cursor()

    c.execute(f"""
      WITH ws AS ({WS}), elig AS ({ELIG})
      SELECT
        (SELECT COUNT(*) FROM ws) distinct_ws_persons,
        (SELECT COUNT(*) FROM ws WHERE EXISTS
           (SELECT 1 FROM elig e WHERE e.fn=ws.fn AND e.ln=ws.ln AND e.dob=ws.dob)) ws_with_match
    """)
    print("summary (distinct_ws_persons, ws_with_match):", c.fetchone())

    c.execute(f"""
      WITH ws AS ({WS}), elig AS ({ELIG})
      SELECT ws.fn, ws.ln, ws.dob,
             COUNT(DISTINCT e.MEMBER_ID) mids, COUNT(DISTINCT e.GroupName) grps
      FROM ws JOIN elig e ON e.fn=ws.fn AND e.ln=ws.ln AND e.dob=ws.dob
      GROUP BY ws.fn, ws.ln, ws.dob
      HAVING COUNT(DISTINCT e.MEMBER_ID) > 1 OR COUNT(DISTINCT e.GroupName) > 1
    """)
    amb = c.fetchall()
    print("ambiguous persons (multi member_id/groupname):", len(amb))
    for r in amb[:30]:
        print("   ", tuple(r))

    if do_update:
        # Deduplicate eligibility to one row per (fn,ln,dob): pick MAX MEMBER_ID / MAX GroupName
        c.execute(f"""
          WITH elig AS ({ELIG}),
          elig1 AS (
            SELECT fn, ln, dob, MAX(MEMBER_ID) MEMBER_ID, MAX(GroupName) GroupName
            FROM elig WHERE dob IS NOT NULL GROUP BY fn, ln, dob
          )
          UPDATE w
            SET w.memberid = e.MEMBER_ID,
                w.GroupName = e.GroupName
          FROM wellsync_data_June w
          JOIN elig1 e
            ON e.fn  = UPPER(LTRIM(RTRIM(JSON_VALUE(w.patient,'$.first_name'))))
           AND e.ln  = UPPER(LTRIM(RTRIM(JSON_VALUE(w.patient,'$.last_name'))))
           AND e.dob = TRY_CONVERT(date, w.patient_dob)
        """)
        print("rows updated:", c.rowcount)
        cn.commit()
        c.execute("SELECT COUNT(*) FROM wellsync_data_June WHERE memberid IS NOT NULL")
        print("rows now populated with memberid:", c.fetchone()[0])

    cn.close()

if __name__ == "__main__":
    run()
