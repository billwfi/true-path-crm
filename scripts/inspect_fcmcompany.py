import pyodbc
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=Bunk?pjb8hah;Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN); c = cn.cursor()

print("=== hsi.fcmcompany columns ===")
c.execute("""SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
             FROM Onbase.INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA='hsi' AND TABLE_NAME='fcmcompany' ORDER BY ORDINAL_POSITION""")
for r in c.fetchall(): print("  ", tuple(r))

print("\n=== distinct active values + counts ===")
c.execute("SELECT active, COUNT(*) FROM Onbase.hsi.fcmcompany GROUP BY active ORDER BY active")
for r in c.fetchall(): print("  active=", repr(r[0]), "count=", r[1])

print("\n=== sample rows where active=0 ===")
c.execute("SELECT TOP 8 * FROM Onbase.hsi.fcmcompany WHERE active=0")
cols = [d[0] for d in c.description]
print("  cols:", cols)
for r in c.fetchall():
    print("  ", tuple(r))
cn.close()
