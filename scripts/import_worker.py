"""Eligibility & Claims import worker.

Runs on the SQL box (stable IP). Reads active feed configs from dbo.Import_Configs,
pulls matching files from each client's SFTP, maps columns, and inserts into the
configured target table. Designed to be invoked frequently by cron (e.g. every
10-15 min); each config runs only when its schedule says it is due.

Env:
  IRX_DB_PWD         SQL Server password for user 'claudeservices'
  IMPORT_CRYPT_KEY   64 hex chars (32 bytes), SAME value as the Netlify env var

Optional overrides: SQLSERVER_HOST (default 74.117.224.152), SQLSERVER_DB (irx),
  SQLSERVER_USER (claudeservices)

Usage:
  python scripts/import_worker.py                # run all due configs
  python scripts/import_worker.py --config 3     # run one config if due
  python scripts/import_worker.py --config 3 --force   # run now, ignore schedule

Requires: pip install pyodbc paramiko openpyxl cryptography
"""
import argparse
import csv
import fnmatch
import io
import os
import posixpath
import sys
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation

import pyodbc
import paramiko
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


# ── DB ──────────────────────────────────────────────────────────────────────
def db_connect():
    conn = (
        "DRIVER={ODBC Driver 17 for SQL Server};"
        f"SERVER={os.environ.get('SQLSERVER_HOST', '74.117.224.152')};"
        f"DATABASE={os.environ.get('SQLSERVER_DB', 'irx')};"
        f"UID={os.environ.get('SQLSERVER_USER', 'claudeservices')};"
        "PWD=" + os.environ["IRX_DB_PWD"] + ";"
        "Encrypt=yes;TrustServerCertificate=yes;"
    )
    return pyodbc.connect(conn, autocommit=True)


def rows_as_dicts(cur):
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


# ── Crypto (mirrors netlify/functions/_crypto.js) ───────────────────────────
def decrypt(blob):
    if not blob:
        return None
    parts = str(blob).split(":")
    if len(parts) != 4 or parts[0] != "v1":
        raise ValueError("bad ciphertext format")
    key = bytes.fromhex(os.environ["IMPORT_CRYPT_KEY"])
    iv = bytes.fromhex(parts[1])
    tag = bytes.fromhex(parts[2])
    ct = bytes.fromhex(parts[3])
    return AESGCM(key).decrypt(iv, ct + tag, None).decode("utf-8")


# ── Schedule ────────────────────────────────────────────────────────────────
def is_due(cfg, now):
    freq = cfg["schedule_frequency"]
    last = cfg["last_run_at"]
    if freq == "Hourly":
        return last is None or (now - last) >= timedelta(minutes=55)
    # Daily / Weekly are gated by time-of-day; default 06:00.
    hh, mm = (cfg["schedule_time"] or "06:00").split(":")
    after_time = now.time() >= datetime(now.year, now.month, now.day, int(hh), int(mm)).time()
    ran_today = last is not None and last.date() >= now.date()
    if freq == "Weekly":
        dow = int(now.strftime("%w"))  # 0=Sun..6=Sat, matches schedule_dow
        if cfg["schedule_dow"] is None or dow != int(cfg["schedule_dow"]):
            return False
    return after_time and not ran_today


# ── File parsing ────────────────────────────────────────────────────────────
def parse_csv(data, delimiter, has_header):
    text = data.decode("utf-8-sig", errors="replace")
    reader = csv.reader(io.StringIO(text), delimiter=(delimiter or ","))
    rows = [r for r in reader if any(c.strip() for c in r)]
    if not rows:
        return [], []
    if has_header:
        return rows[0], rows[1:]
    width = max(len(r) for r in rows)
    return [str(i + 1) for i in range(width)], rows


def parse_xlsx(data, sheet_name, has_header):
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    ws = wb[sheet_name] if sheet_name and sheet_name in wb.sheetnames else wb[wb.sheetnames[0]]
    rows = [["" if c is None else c for c in row] for row in ws.iter_rows(values_only=True)]
    rows = [r for r in rows if any(str(c).strip() for c in r)]
    if not rows:
        return [], []
    if has_header:
        return [str(c) for c in rows[0]], rows[1:]
    width = max(len(r) for r in rows)
    return [str(i + 1) for i in range(width)], rows


# ── Value coercion ──────────────────────────────────────────────────────────
def coerce(value, dtype):
    if value is None:
        return None
    s = value if isinstance(value, str) else str(value)
    s = s.strip()
    if s == "":
        return None
    if dtype == "int":
        try:
            return int(float(s))
        except ValueError:
            return None
    if dtype == "decimal":
        try:
            return Decimal(s.replace(",", ""))
        except (InvalidOperation, ValueError):
            return None
    if dtype in ("date", "datetime"):
        for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y-%m-%d %H:%M:%S", "%m/%d/%Y %H:%M"):
            try:
                dt = datetime.strptime(s, fmt)
                return dt.date() if dtype == "date" else dt
            except ValueError:
                continue
        return None
    return s


# ── Import one file ─────────────────────────────────────────────────────────
def import_rows(cur, target_table, maps, header, data_rows, truncate):
    idx = {name: i for i, name in enumerate(header)}
    # Resolve each mapping's source position; warn-skip mappings whose source is absent.
    resolved = []
    for m in maps:
        src = m["source_column"]
        pos = idx.get(src)
        if pos is None and src.isdigit():
            pos = int(src) - 1  # 1-based index fallback
        if pos is None:
            raise ValueError(f"source column '{src}' not found in file header")
        resolved.append((pos, m["target_column"], m.get("data_type")))

    target_cols = [t for _, t, _ in resolved]
    collist = ", ".join(f"[{c}]" for c in target_cols)
    placeholders = ", ".join("?" for _ in target_cols)

    out = []
    for r in data_rows:
        out.append(tuple(
            coerce(r[pos] if pos < len(r) else None, dt) for pos, _, dt in resolved
        ))

    if truncate:
        cur.execute(f"TRUNCATE TABLE {target_table}")
    if out:
        cur.fast_executemany = True
        cur.executemany(f"INSERT INTO {target_table} ({collist}) VALUES ({placeholders})", out)
    return len(out)


# ── SFTP ────────────────────────────────────────────────────────────────────
def sftp_connect(cfg):
    transport = paramiko.Transport((cfg["sftp_host"], int(cfg["sftp_port"] or 22)))
    pkey = None
    key_pem = decrypt(cfg.get("sftp_key_enc"))
    if key_pem:
        pkey = paramiko.RSAKey.from_private_key(io.StringIO(key_pem))
    password = decrypt(cfg.get("sftp_password_enc"))
    transport.connect(username=cfg["sftp_username"], password=password, pkey=pkey)
    return paramiko.SFTPClient.from_transport(transport), transport


# ── Run a single config ─────────────────────────────────────────────────────
def run_config(cn, cfg):
    cur = cn.cursor()
    cur.execute(
        "INSERT INTO dbo.Import_Runs (config_id, status) OUTPUT INSERTED.id VALUES (?, 'Running')",
        cfg["id"])
    run_id = cur.fetchone()[0]

    def finish(status, file_name=None, rows=None, message=None):
        cur.execute(
            "UPDATE dbo.Import_Runs SET finished_at=GETDATE(), status=?, file_name=?, rows_imported=?, message=? WHERE id=?",
            status, file_name, rows, (message[:3900] if message else None), run_id)
        cur.execute("UPDATE dbo.Import_Configs SET last_run_at=GETDATE() WHERE id=?", cfg["id"])

    try:
        cur.execute(
            "SELECT source_column, target_column, data_type FROM dbo.Import_Column_Maps WHERE config_id=? ORDER BY ordinal, id",
            cfg["id"])
        maps = rows_as_dicts(cur)
        if not maps:
            finish("Error", message="No column mappings defined")
            return

        sftp, transport = sftp_connect(cfg)
        try:
            listing = sftp.listdir_attr(cfg["remote_dir"] or "/")
        finally:
            pass

        names = [a.filename for a in listing
                 if fnmatch.fnmatch(a.filename, cfg["file_pattern"] or "*")]
        cur.execute("SELECT file_name FROM dbo.Import_Processed_Files WHERE config_id=?", cfg["id"])
        done = {r[0] for r in cur.fetchall()}
        todo = sorted(n for n in names if n not in done)

        if not todo:
            sftp.close(); transport.close()
            finish("NoFile", message=f"No new files matching {cfg['file_pattern']}")
            return

        total = 0
        last_file = None
        for name in todo:
            remote_path = posixpath.join(cfg["remote_dir"] or "/", name)
            with sftp.open(remote_path, "rb") as fh:
                data = fh.read()
            if cfg["file_format"] == "xlsx":
                header, body = parse_xlsx(data, cfg.get("sheet_name"), cfg["has_header"])
            else:
                header, body = parse_csv(data, cfg.get("delimiter"), cfg["has_header"])
            n = import_rows(cur, cfg["target_table"], maps, header, body,
                            cfg["truncate_before"] and name == todo[0])
            cur.execute(
                "INSERT INTO dbo.Import_Processed_Files (config_id, file_name, rows_imported) VALUES (?,?,?)",
                cfg["id"], name, n)
            total += n
            last_file = name
            # after-import disposition
            if cfg["after_import"] == "delete":
                sftp.remove(remote_path)
            elif cfg["after_import"] == "archive" and cfg.get("archive_dir"):
                try:
                    sftp.rename(remote_path, posixpath.join(cfg["archive_dir"], name))
                except IOError:
                    pass

        sftp.close(); transport.close()
        finish("Success", file_name=(last_file if len(todo) == 1 else f"{len(todo)} files"),
               rows=total, message=f"Imported {total} rows from {len(todo)} file(s)")
    except Exception as e:  # noqa: BLE001 - record any failure on the run
        finish("Error", message=f"{type(e).__name__}: {e}")
        print(f"[config {cfg['id']}] ERROR: {e}", file=sys.stderr)


# ── Main ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", type=int, help="run only this config id")
    ap.add_argument("--force", action="store_true", help="ignore schedule (with --config)")
    args = ap.parse_args()

    cn = db_connect()
    cur = cn.cursor()
    where = "WHERE active=1" + (" AND id=?" if args.config else "")
    params = (args.config,) if args.config else ()
    cur.execute(
        "SELECT id, client_id, name, feed_type, sftp_host, sftp_port, sftp_username, "
        "sftp_password_enc, sftp_key_enc, remote_dir, file_pattern, file_format, delimiter, "
        "has_header, sheet_name, target_table, truncate_before, after_import, archive_dir, "
        "schedule_frequency, schedule_time, schedule_dow, last_run_at "
        f"FROM dbo.Import_Configs {where}", *params)
    cfgs = rows_as_dicts(cur)

    now = datetime.now()
    ran = 0
    for cfg in cfgs:
        if args.force or is_due(cfg, now):
            print(f"Running config {cfg['id']} ({cfg['name']})…")
            run_config(cn, cfg)
            ran += 1
    print(f"Done. {ran} of {len(cfgs)} config(s) run.")
    cn.close()


if __name__ == "__main__":
    main()
