import pyodbc, sys
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=Bunk?pjb8hah;Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN, autocommit=False); c = cn.cursor()
do_insert = '--insert' in sys.argv

print("=== existing tp_companies ===")
c.execute("SELECT id, name FROM tp_companies ORDER BY id")
for r in c.fetchall(): print("  ", tuple(r))

# Mapped source rows (trimmed). Address = Address + ' ' + Address 2 (when present).
SRC = """
SELECT
  LTRIM(RTRIM([Name])) AS name,
  NULLIF(LTRIM(RTRIM(
     LTRIM(RTRIM(ISNULL([Address],''))) +
     CASE WHEN LTRIM(RTRIM(ISNULL([Address 2],'')))<>'' THEN ' '+LTRIM(RTRIM([Address 2])) ELSE '' END)), '') AS address,
  NULLIF(LTRIM(RTRIM([City])),'')     AS city,
  NULLIF(LTRIM(RTRIM([State])),'')    AS state,
  NULLIF(LTRIM(RTRIM([Zip Code])),'') AS zip_code,
  LTRIM(RTRIM(ISNULL([Status],''))) AS status
FROM Onbase.hsi.rm_vwiRxCompanies
WHERE LTRIM(RTRIM(ISNULL([Name],''))) <> ''
"""
print("\n=== source rows from view (activestatus=0, trimmed) ===")
c.execute(SRC)
rows = c.fetchall()
print("  total:", len(rows))
for r in rows: print("  ", tuple(r))

if do_insert:
    # Insert names not already present (case-insensitive), de-duped within source.
    ins = f"""
    INSERT INTO tp_companies (name, address, city, state, zip_code)
    SELECT s.name, MIN(s.address), MIN(s.city), MIN(s.state), MIN(s.zip_code)
    FROM ({SRC}) s
    WHERE NOT EXISTS (SELECT 1 FROM tp_companies t WHERE t.name = s.name)
    GROUP BY s.name
    """
    c.execute(ins)
    print("\nrows inserted:", c.rowcount)
    cn.commit()
    c.execute("SELECT id, name, city, state FROM tp_companies ORDER BY id")
    print("=== tp_companies after import ===")
    for r in c.fetchall(): print("  ", tuple(r))
cn.close()
