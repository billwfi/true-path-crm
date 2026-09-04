import pyodbc
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=Bunk?pjb8hah;Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN); c = cn.cursor()

print("=== all base tables in irx ===")
c.execute("""SELECT TABLE_SCHEMA, TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
             WHERE TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME""")
tables = [(r[0], r[1]) for r in c.fetchall()]
for t in tables: print("  ", t[0] + "." + t[1])

print("\n=== source view: distinct Status values ===")
c.execute("SELECT [Status], COUNT(*) FROM Onbase.hsi.rm_vwiRxCompanies GROUP BY [Status] ORDER BY COUNT(*) DESC")
for r in c.fetchall(): print("  ", repr(r[0]), r[1])

print("\n=== source view sample rows ===")
c.execute("SELECT TOP 5 [Client ID],[Name],[Address],[City],[State],[Zip Code],[Status] FROM Onbase.hsi.rm_vwiRxCompanies")
for r in c.fetchall(): print("  ", tuple(r))

print("\n=== search candidate tables for 'Workflow Innovators' ===")
for sch, tbl in tables:
    # find char/varchar columns
    c.execute("""SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND DATA_TYPE IN ('varchar','nvarchar','char','nchar')""", sch, tbl)
    cols = [r[0] for r in c.fetchall()]
    if not cols:
        continue
    conds = " OR ".join(f"[{cc}] LIKE '%Workflow Innovators%'" for cc in cols)
    try:
        c.execute(f"SELECT COUNT(*) FROM [{sch}].[{tbl}] WHERE {conds}")
        n = c.fetchone()[0]
        if n:
            print(f"  FOUND in {sch}.{tbl}: {n} row(s)")
    except Exception as e:
        pass
cn.close()
