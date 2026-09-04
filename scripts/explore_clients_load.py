import pyodbc
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=Bunk?pjb8hah;Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN); c = cn.cursor()

print("=== irx tables matching 'client' ===")
c.execute("""SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES
             WHERE TABLE_NAME LIKE '%client%' ORDER BY TABLE_NAME""")
for r in c.fetchall(): print("  ", tuple(r))

print("\n=== source view access check: Onbase.hsi.rm_vwiRxCompanies ===")
try:
    c.execute("SELECT COUNT(*) total, SUM(CASE WHEN activestatus=0 THEN 1 ELSE 0 END) inactive FROM Onbase.hsi.rm_vwiRxCompanies")
    print("  counts (total, activestatus=0):", c.fetchone())
except Exception as e:
    print("  ERROR accessing view:", e)

print("\n=== source view columns ===")
try:
    c.execute("""SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
                 FROM Onbase.INFORMATION_SCHEMA.COLUMNS
                 WHERE TABLE_SCHEMA='hsi' AND TABLE_NAME='rm_vwiRxCompanies' ORDER BY ORDINAL_POSITION""")
    for r in c.fetchall(): print("  ", tuple(r))
except Exception as e:
    print("  ERROR:", e)

cn.close()
