import pyodbc
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=Bunk?pjb8hah;Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN); c = cn.cursor()

print("=== Onbase objects matching RxCompan ===")
c.execute("""SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM Onbase.INFORMATION_SCHEMA.TABLES
             WHERE TABLE_NAME LIKE '%RxCompan%' ORDER BY TABLE_NAME""")
for r in c.fetchall(): print("  ", tuple(r))

print("\n=== Onbase columns named like %active% (any table) ===")
c.execute("""SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM Onbase.INFORMATION_SCHEMA.COLUMNS
             WHERE COLUMN_NAME LIKE '%active%' AND (TABLE_NAME LIKE '%RxCompan%' OR TABLE_NAME LIKE '%Compan%' OR TABLE_NAME LIKE '%rm[_]%')
             ORDER BY TABLE_NAME, COLUMN_NAME""")
rows = c.fetchall()
for r in rows: print("  ", tuple(r))
if not rows:
    print("  (none on RxCompanies/rm_ objects)")

print("\n=== full column list of rm_vwiRxCompanies (recap) ===")
c.execute("""SELECT COLUMN_NAME, DATA_TYPE FROM Onbase.INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA='hsi' AND TABLE_NAME='rm_vwiRxCompanies' ORDER BY ORDINAL_POSITION""")
for r in c.fetchall(): print("  ", tuple(r))
cn.close()
