"""Add-only claims loader for the per-client claims tables the app reads.

Claims are cumulative — each monthly file is only that period's claims — so this
APPENDS new claim lines and never truncates. Rows already present (by the client's
dedupe key) are skipped, so re-running a file is idempotent. Columns are matched by
exact header name (the HRx/vendor files already use the target table's column names).

Env: IRX_DB_PWD, MCR_SFTP_PWD
Usage: python claims_loader.py [client]      (default: all in CLAIMS)
"""
import io, os, csv, sys, fnmatch
import paramiko, pyodbc, openpyxl

SFTP_HOST, SFTP_USER = "us-east-1.sftpcloud.io", "MANAGER"
DEDUPE = ["Patient ID", "Date Of Service", "NDC", "Pharmacy Rx Number", "Fill Number"]

# client -> feed. target = the table the app reads for this carrier (claims.js SOURCES).
CLAIMS = {
    "cseamericas": {"label": "CSE Americas", "client_id": 12,
        "folder": "/InternationalRx/CSEAmericas", "pattern": "HRx_Prime_CSEAmericas_Claims_*.xlsx",
        "fmt": "xlsx", "header_row": 1, "target": "ClaimsData_CSEAmericas", "clientid": "020373"},
    "cityofmission": {"label": "City of Mission", "client_id": 27,
        "folder": "/InternationalRx/CityOfMission", "pattern": "HRx_*CityofMission_Claims_*.xlsx",
        "fmt": "xlsx", "header_row": 1, "target": "ClaimsData_CityofMission", "clientid": "077803"},
    "smithcounty": {"label": "Smith County", "client_id": 28,
        "folder": "/InternationalRx/SmithCounty", "pattern": "HRx_*SmithCounty_Claims_*.xls*",
        "fmt": "xlsx", "header_row": 1, "target": "ClaimsData_SmithCounty", "clientid": "PSI1022"},
    # Anders ships a narrow Rx extract ("Rx Claim Details ... Upload into OnBase.xlsx")
    # with no Client ID column of its own and a per-line unique Claim ID, so it needs
    # a constant Client ID injected and Claim ID as the dedupe key. See migration 033.
    "anders": {"label": "Anders Group", "client_id": 6,
        "folder": "/InternationalRx/Anders", "pattern": "Rx Claim Details*ANDERS*.xls*",
        "fmt": "xlsx", "header_row": 1, "target": "ClaimsData_Anders", "clientid": "000239911",
        "dedupe": ["Claim ID"], "constants": {"Client ID": "000239911"}},
}


def db():
    # Deployment ships ODBC Driver 17; allow an override so the loader also runs
    # on boxes that only have 18 (e.g. a dev machine) without a code change.
    driver = os.environ.get("SQLSERVER_ODBC_DRIVER", "ODBC Driver 17 for SQL Server")
    return pyodbc.connect(
        f"DRIVER={{{driver}}};SERVER=tcp:74.117.224.152,1433;DATABASE=iRx;"
        f"UID=claudeservices;PWD={os.environ['IRX_DB_PWD']};Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=30",
        autocommit=True)


def sftp():
    t = paramiko.Transport((SFTP_HOST, 22)); t.connect(username=SFTP_USER, password=os.environ["MCR_SFTP_PWD"])
    return paramiko.SFTPClient.from_transport(t), t


def parse(data, fmt, header_row):
    if fmt == "xlsx":
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
        rows = [["" if c is None else c for c in r] for r in wb[wb.sheetnames[0]].iter_rows(values_only=True)]
    else:
        rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig", errors="replace"))))
    hidx = header_row - 1
    header = [str(c).strip() for c in rows[hidx]]
    body = [r for r in rows[hidx + 1:] if any(str(c).strip() for c in r)]
    return header, body


def norm(v):
    return "" if v is None else str(v).strip()


def load_client(cn, key, cfg):
    cur = cn.cursor()
    log = cur.execute(
        "INSERT INTO dbo.Client_Import_Log (client_key, client_id, feed_name, target_table, status) "
        "OUTPUT INSERTED.id VALUES (?,?,?,?, 'Running')",
        "claims_" + key, cfg.get("client_id"), "Claims", cfg["target"]).fetchone()[0]
    try:
        meta = cur.execute(
            "SELECT COLUMN_NAME, CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME=?",
            cfg["target"]).fetchall()
        tcols = [m[0] for m in meta]
        tset = {c.lower(): c for c in tcols}
        # per-column max length so a longer vendor value is trimmed instead of failing the insert
        maxlen = {m[0]: m[1] for m in meta if m[1] and m[1] > 0}
        s, transport = sftp()
        try:
            files = sorted(a.filename for a in s.listdir_attr(cfg["folder"])
                           if fnmatch.fnmatch(a.filename, cfg["pattern"]))
        finally:
            pass
        if not files:
            s.close(); transport.close()
            cur.execute("UPDATE dbo.Client_Import_Log SET status='NoFile', finished_at=GETDATE() WHERE id=?", log)
            return f"[{key}] no files matching {cfg['pattern']}"

        # existing dedupe keys already loaded for this client (a feed may override
        # the default key set, e.g. Anders dedupes on its unique Claim ID)
        keycols = [c for c in cfg.get("dedupe", DEDUPE) if c.lower() in tset]
        ksel = ", ".join(f"[{tset[c.lower()]}]" for c in keycols)
        cur.execute(f"SELECT {ksel} FROM dbo.[{cfg['target']}] WHERE [Client ID]=?", cfg["clientid"])
        seen = {tuple(norm(v) for v in r) for r in cur.fetchall()}

        added = 0
        for name in files:
            with s.open(cfg["folder"].rstrip("/") + "/" + name, "rb") as fh:
                data = fh.read()
            header, body = parse(data, cfg["fmt"], cfg["header_row"])
            # map file header -> target columns present (exact name match)
            cols = [(i, tset[h.lower()]) for i, h in enumerate(header) if h.lower() in tset]
            # constant columns not present in the file (e.g. a Client ID the file
            # does not carry), appended to every row
            const_cols = [(tset[k.lower()], v) for k, v in cfg.get("constants", {}).items()
                          if k.lower() in tset]
            target_cols = [c for _, c in cols] + [c for c, _ in const_cols]
            kpos = [target_cols.index(tset[c.lower()]) for c in keycols]
            batch = []
            for r in body:
                vals = [(norm(r[i]) if i < len(r) else "")[:maxlen.get(c, 100000)] for i, c in cols]
                vals += [norm(v)[:maxlen.get(c, 100000)] for c, v in const_cols]
                kv = tuple(vals[p] for p in kpos)
                if kv in seen:
                    continue
                seen.add(kv); batch.append(tuple(vals))
            if batch:
                collist = ", ".join(f"[{c}]" for c in target_cols)
                ph = ", ".join("?" for _ in target_cols)
                cur.fast_executemany = True
                cur.executemany(f"INSERT INTO dbo.[{cfg['target']}] ({collist}) VALUES ({ph})", batch)
                added += len(batch)
        s.close(); transport.close()
        cur.execute("UPDATE dbo.Client_Import_Log SET status='Success', rows_loaded=?, finished_at=GETDATE(), "
                    "message=? WHERE id=?", added, f"Added {added} new claims from {len(files)} file(s)", log)
        return f"[{key}] added {added} new claims -> {cfg['target']} ({len(files)} files)"
    except Exception as e:  # noqa: BLE001
        cur.execute("UPDATE dbo.Client_Import_Log SET status='Error', finished_at=GETDATE(), message=? WHERE id=?",
                    str(e)[:3900], log)
        return f"[{key}] ERROR: {e}"


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    cn = db()
    for key, cfg in CLAIMS.items():
        if only and key != only:
            continue
        print(load_client(cn, key, cfg))
    cn.close()


if __name__ == "__main__":
    main()
