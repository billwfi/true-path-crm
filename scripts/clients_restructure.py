import pyodbc
CONN = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;"
        "DATABASE=irx;UID=claudeservices;PWD=Bunk?pjb8hah;Encrypt=yes;TrustServerCertificate=yes;")
cn = pyodbc.connect(CONN, autocommit=False); c = cn.cursor()

# 1) Add company-oriented columns to tp_clients
adds = [("name", "NVARCHAR(255)"), ("address", "NVARCHAR(255)"), ("city", "NVARCHAR(100)"),
        ("state", "NVARCHAR(50)"), ("zip_code", "NVARCHAR(25)")]
for col, typ in adds:
    c.execute(f"IF COL_LENGTH('dbo.tp_clients','{col}') IS NULL ALTER TABLE tp_clients ADD [{col}] {typ} NULL")
cn.commit()

# 2) Backfill name for existing person rows from firstname/lastname
c.execute("""UPDATE tp_clients
   SET name = NULLIF(LTRIM(RTRIM(CONCAT(ISNULL(firstname,''),' ',ISNULL(lastname,'')))),'')
   WHERE name IS NULL""")
print("backfilled existing names:", c.rowcount)
cn.commit()

# 3) Load OnBase companies (activestatus=0) as clients; Client ID -> irx_client_id.
SRC = """
SELECT
  LTRIM(RTRIM([Name])) AS name,
  NULLIF(LTRIM(RTRIM(
     LTRIM(RTRIM(ISNULL([Address],''))) +
     CASE WHEN LTRIM(RTRIM(ISNULL([Address 2],'')))<>'' THEN ' '+LTRIM(RTRIM([Address 2])) ELSE '' END)),'') AS address,
  NULLIF(LTRIM(RTRIM([City])),'')     AS city,
  NULLIF(LTRIM(RTRIM([State])),'')    AS state,
  NULLIF(LTRIM(RTRIM([Zip Code])),'') AS zip_code,
  NULLIF(LTRIM(RTRIM([Client ID])),'') AS irx_client_id
FROM Onbase.hsi.rm_vwiRxCompanies
WHERE LTRIM(RTRIM(ISNULL([Name],''))) <> ''
"""
c.execute(f"""
INSERT INTO tp_clients (name, address, city, state, zip_code, irx_client_id, active)
SELECT s.name, MIN(s.address), MIN(s.city), MIN(s.state), MIN(s.zip_code), MIN(s.irx_client_id), 1
FROM ({SRC}) s
WHERE NOT EXISTS (SELECT 1 FROM tp_clients t
                  WHERE (t.irx_client_id IS NOT NULL AND t.irx_client_id = s.irx_client_id)
                     OR t.name = s.name)
GROUP BY s.name
""")
print("companies inserted as clients:", c.rowcount)
cn.commit()

print("\n=== tp_clients now ===")
c.execute("SELECT id, name, irx_client_id, city, state, active FROM tp_clients ORDER BY name")
for r in c.fetchall(): print("  ", tuple(r))
cn.close()
