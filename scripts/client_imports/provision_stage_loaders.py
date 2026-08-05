"""Provision SAFE staging-only Import_Configs for client feeds.

For each feed spec: read the newest matching file's header, (re)create the staging
table with an NVARCHAR column per header, and upsert an Import_Config + its
Import_Column_Maps (1:1, string). NO reconcile map is created, so import_worker
loads the file into staging and stops — it never touches dbo.eligibility.

All feeds share the same SFTP account (MANAGER @ sftpcloud), so the encrypted
credential is copied from an existing config (TEMPLATE_CFG). Older matching files
are marked processed so the first run loads only the newest file.

Env: IRX_DB_PWD, MCR_SFTP_PWD
"""
import io, os, csv, re, fnmatch
import paramiko, pyodbc, openpyxl

TEMPLATE_CFG = 1013  # any existing config on the same SFTP — we copy its creds

# (client_id, name, remote_dir, pattern, file_format, target_table, header_row)
FEEDS = [
    (16, "Herrs Foods Eligibility (staging)", "/InternationalRx/HerrsFoods",
     "InternationalRX_Magellan_eligibility_*.csv", "csv", "Eligibility_HerrsFoods", 1),
    (21, "Ridgecrest Eligibility (staging)", "/InternationalRx/Ridgecrest/Incoming/incoming",
     "K85_Ridgecrest_PERSONIFY_ELIG*.csv", "csv", "Eligibility_Ridgecrest", 1),
    (None, "PAQ Eligibility (staging)", "/InternationalRx/PAQ",
     "PAQ*EligibilityByMember_*.csv", "csv", "Eligibility_PAQ", 1),
    (12, "CSE Americas Eligibility (staging)", "/InternationalRx/CSEAmericas/Archive",
     "CSEAMERICAS_*.csv", "csv", "Eligibility_CSEAmericas", 1),
    (None, "Lopez Foods Eligibility (staging)", "/InternationalRx/LopezDoradaFoods",
     "HRx_BCBS_LopezFoods_Eligibility_*.xlsx", "xlsx", "Eligibility_LopezFoods", 1),
]


def db():
    return pyodbc.connect(
        "DRIVER={ODBC Driver 17 for SQL Server};SERVER=tcp:74.117.224.152,1433;DATABASE=iRx;"
        f"UID=claudeservices;PWD={os.environ['IRX_DB_PWD']};Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=30",
        autocommit=True)


def sanitize(headers):
    """Map raw headers to safe, unique SQL column names."""
    out, seen = [], {}
    for i, h in enumerate(headers):
        base = re.sub(r"[^0-9A-Za-z_]", "_", (str(h) or "").strip()) or f"col{i+1}"
        if re.match(r"^\d", base):
            base = "c_" + base
        base = base[:120]
        n = seen.get(base.lower(), 0) + 1
        seen[base.lower()] = n
        out.append(base if n == 1 else f"{base}_{n}")
    return out


def read_header(sftp, folder, name, fmt, header_row):
    with sftp.open(folder.rstrip("/") + "/" + name, "rb") as fh:
        data = fh.read()
    if fmt == "xlsx":
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        for row in wb[wb.sheetnames[0]].iter_rows(min_row=header_row, max_row=header_row, values_only=True):
            return [("" if c is None else str(c)).strip() for c in row]
    else:
        text = data.decode("utf-8-sig", errors="replace")
        rows = list(csv.reader(io.StringIO(text)))
        return [c.strip() for c in rows[header_row - 1]] if rows else []
    return []


def main():
    cn = db(); cur = cn.cursor()
    t = paramiko.Transport(("us-east-1.sftpcloud.io", 22))
    t.connect(username="MANAGER", password=os.environ["MCR_SFTP_PWD"])
    sftp = paramiko.SFTPClient.from_transport(t)

    tpl = cur.execute(
        "SELECT sftp_host, sftp_port, sftp_username, sftp_password_enc FROM dbo.Import_Configs WHERE id=?",
        TEMPLATE_CFG).fetchone()

    for client_id, name, folder, pattern, fmt, table, hrow in FEEDS:
        if client_id is None:
            print(f"  [{name}] SKIP — no tp_clients record yet (create one to enable)"); continue
        try:
            files = sorted(a.filename for a in sftp.listdir_attr(folder)
                           if fnmatch.fnmatch(a.filename, pattern))
        except Exception as e:
            print(f"  [{name}] SKIP — cannot list {folder}: {e}"); continue
        if not files:
            print(f"  [{name}] SKIP — no files matching {pattern} in {folder}"); continue
        newest = files[-1]
        headers = read_header(sftp, folder, newest, fmt, hrow)
        cols = sanitize(headers)
        if not cols:
            print(f"  [{name}] SKIP — no header columns read"); continue

        # (Re)create the staging table to match the file exactly (scratch/full-refresh).
        cur.execute(f"IF OBJECT_ID('dbo.{table}','U') IS NOT NULL DROP TABLE dbo.{table}")
        coldefs = ", ".join(f"[{c}] NVARCHAR(4000) NULL" for c in cols)
        cur.execute(f"CREATE TABLE dbo.{table} ({coldefs})")

        # Upsert the config (idempotent by name).
        existing = cur.execute("SELECT id FROM dbo.Import_Configs WHERE name=?", name).fetchone()
        if existing:
            cid = existing[0]
            cur.execute("DELETE FROM dbo.Import_Column_Maps WHERE config_id=?", cid)
            cur.execute("DELETE FROM dbo.Import_Processed_Files WHERE config_id=?", cid)
            cur.execute("""UPDATE dbo.Import_Configs SET client_id=?, remote_dir=?, file_pattern=?,
                           file_format=?, target_table=?, header_row=?, active=1, reconcile_table=NULL,
                           truncate_before=1, has_header=1 WHERE id=?""",
                        client_id, folder, pattern, fmt, "dbo." + table, hrow, cid)
        else:
            cur.execute("""INSERT INTO dbo.Import_Configs
                (client_id, name, feed_type, sftp_host, sftp_port, sftp_username, sftp_password_enc,
                 remote_dir, file_pattern, file_format, delimiter, has_header, header_row, target_table,
                 truncate_before, schedule_frequency, schedule_time, schedule_dow, active)
                OUTPUT INSERTED.id
                VALUES (?,?, 'Eligibility', ?,?,?,?, ?,?,?, ',', 1, ?, ?, 1, 'Weekly','06:00',1, 1)""",
                client_id, name, tpl[0], tpl[1], tpl[2], tpl[3],
                folder, pattern, fmt, hrow, "dbo." + table)
            cid = cur.fetchone()[0]

        for i, (src, tgt) in enumerate(zip(headers, cols)):
            cur.execute("INSERT INTO dbo.Import_Column_Maps (config_id, source_column, target_column, data_type, ordinal) VALUES (?,?,?,?,?)",
                        cid, src, tgt, "string", i)

        # Load only the newest: mark all older matching files as already processed.
        for old in files[:-1]:
            cur.execute("INSERT INTO dbo.Import_Processed_Files (config_id, file_name, rows_imported) VALUES (?,?,0)", cid, old)

        print(f"  [{name}] cfg#{cid} -> dbo.{table} ({len(cols)} cols); newest={newest}; "
              f"{len(files)-1} older marked processed")
    t.close()
    print("Done.")


if __name__ == "__main__":
    main()
