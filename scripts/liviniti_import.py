"""Liviniti (RxCompass) eligibility SFTP importer.

Pulls the newest weekly batch of per-company eligibility CSVs from
sftp.liviniti.com:/incoming/rxcompass and truncate-reloads them into ONE staging
table dbo.Eligibility_Liviniti (each row tagged with SourceFile / CompanyName /
FileDate). Does NOT touch production eligibility. Logs a run summary to
dbo.Client_Import_Log and emails a branded TruePath Sourcing summary via ACS.

Files are named  "RxCompass <Company> Elig <YYYY-MM-DD>.csv"  and accumulate week
over week, so we load only the latest date present (or LIVINITI_DATE if set).

Env:
  LIVINITI_SFTP_PWD   SFTP password for user InternationalRx
  IRX_DB_PWD          SQL Server password for 'claudeservices'
  ACS_CONNECTION_STRING   ACS connection string (for the summary email)
  EMAIL_TO            recipient (default liviniti@truepathsourcing.com)
  EMAIL_FROM          sender   (default noreply@truepathsourcing.com)
  LIVINITI_DATE       optional YYYY-MM-DD to force a specific batch date
  RECREATE            "1" to DROP+CREATE the table (schema change)
"""
import io
import os
import re
import csv
import sys
from datetime import datetime

import pyodbc
import paramiko

HOST = "sftp.liviniti.com"
PORT = 22
USER = "InternationalRx"
REMOTE = "/incoming/rxcompass"
TABLE = "Eligibility_Liviniti"
FNAME_RE = re.compile(r"^RxCompass (.+) Elig (\d{4}-\d{2}-\d{2})\.csv$", re.I)
EXTRA_COLS = ["SourceFile", "CompanyName", "FileDate"]
BATCH = 5000


def db(autocommit=False):
    cs = ("DRIVER={ODBC Driver 17 for SQL Server};"
          f"SERVER={os.environ.get('SQLSERVER_HOST', '74.117.224.152')};"
          f"DATABASE={os.environ.get('SQLSERVER_DB', 'iRx')};"
          f"UID={os.environ.get('SQLSERVER_USER', 'claudeservices')};"
          f"PWD={os.environ['IRX_DB_PWD']};Encrypt=yes;TrustServerCertificate=yes;")
    return pyodbc.connect(cs, autocommit=autocommit)


def sftp_connect():
    t = paramiko.Transport((HOST, PORT))
    t.connect(username=USER, password=os.environ["LIVINITI_SFTP_PWD"])
    return paramiko.SFTPClient.from_transport(t), t


def sanitize(name):
    s = re.sub(r"[^0-9A-Za-z_]", "_", (name or "").strip())
    s = re.sub(r"_+", "_", s).strip("_") or "col"
    return "_" + s if s[0].isdigit() else s


def ensure_table(cur, header_cols, recreate):
    cols = [sanitize(h) for h in header_cols]
    exists = cur.execute("SELECT OBJECT_ID(?, 'U')", f"dbo.{TABLE}").fetchone()[0] is not None
    if recreate and exists:
        cur.execute(f"DROP TABLE dbo.[{TABLE}]")
        exists = False
    if not exists:
        defs = ",\n  ".join(f"[{c}] NVARCHAR(512) NULL" for c in cols)
        cur.execute(
            f"CREATE TABLE dbo.[{TABLE}] (\n  {defs},\n"
            "  [SourceFile] NVARCHAR(260) NULL,\n"
            "  [CompanyName] NVARCHAR(200) NULL,\n"
            "  [FileDate] DATE NULL,\n"
            "  [LoadedAt] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()\n)")
        print(f"created dbo.{TABLE} ({len(cols)} data columns + 4 meta)")
    else:
        cur.execute(f"TRUNCATE TABLE dbo.[{TABLE}]")
        print(f"truncated dbo.{TABLE}")
    return cols


def load_file(cur, cols, data, filename, company, file_date):
    text = data.decode("utf-8-sig", "replace")
    reader = csv.reader(io.StringIO(text))
    try:
        next(reader)  # header (schema already fixed from the first file)
    except StopIteration:
        return 0
    ncol = len(cols)
    collist = ", ".join(f"[{c}]" for c in cols) + ", [SourceFile], [CompanyName], [FileDate]"
    placeholders = ", ".join("?" for _ in range(ncol + 3))
    sql = f"INSERT INTO dbo.[{TABLE}] ({collist}) VALUES ({placeholders})"
    cur.fast_executemany = True
    buf, total = [], 0
    for row in reader:
        cells = [(row[i] if i < len(row) else None) for i in range(ncol)]
        cells = [(c if (c is not None and c != "") else None) for c in cells]
        buf.append(cells + [filename[:260], company[:200], file_date])
        if len(buf) >= BATCH:
            cur.executemany(sql, buf); total += len(buf); buf = []
    if buf:
        cur.executemany(sql, buf); total += len(buf)
    return total


def send_email(summary):
    cs = os.environ.get("ACS_CONNECTION_STRING")
    if not cs:
        print("no ACS_CONNECTION_STRING; skipping email"); return
    from azure.communication.email import EmailClient
    to = os.environ.get("EMAIL_TO", "liviniti@truepathsourcing.com")
    frm = os.environ.get("EMAIL_FROM", "noreply@truepathsourcing.com")
    rows = "".join(
        f"<tr><td style='padding:4px 10px;border-bottom:1px solid #eee;'>{c}</td>"
        f"<td style='padding:4px 10px;border-bottom:1px solid #eee;text-align:right;'>{n:,}</td></tr>"
        for c, n in summary["top"])
    err = ""
    if summary["errors"]:
        err = ("<p style='color:#b91c1c;font-weight:600;margin:16px 0 4px;'>Files with errors:</p><ul>"
               + "".join(f"<li>{e}</li>" for e in summary["errors"][:20]) + "</ul>")
    html = f"""<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5f5;padding:24px 0;font-family:Arial,Helvetica,sans-serif;"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
  <tr><td style="background:#223f72;padding:20px 32px;" align="center">
    <img src="https://app.truepathsourcing.com/assets/img/truepath-logo-white.png" alt="True Path Sourcing" width="200" style="display:block;max-width:200px;height:auto;"></td></tr>
  <tr><td style="padding:28px 32px;color:#1e293b;font-size:15px;line-height:1.6;">
    <p style="margin:0 0 12px;font-size:19px;font-weight:700;color:#0a5e57;">Liviniti / RxCompass Eligibility Load</p>
    <p style="margin:0 0 6px;"><b>Status:</b> {summary['status']}</p>
    <p style="margin:0 0 6px;"><b>Batch date:</b> {summary['file_date']}</p>
    <p style="margin:0 0 6px;"><b>Files loaded:</b> {summary['files_ok']} of {summary['files_total']}</p>
    <p style="margin:0 0 6px;"><b>Total member rows:</b> {summary['rows']:,}</p>
    <p style="margin:0 0 16px;"><b>Table:</b> dbo.Eligibility_Liviniti &nbsp;&bull;&nbsp; <b>Run:</b> {summary['run_at']} UTC</p>
    {err}
    <p style="margin:16px 0 6px;font-weight:600;">Top companies by member count</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;font-size:13px;border-collapse:collapse;">
      <tr><th style="text-align:left;padding:4px 10px;border-bottom:2px solid #223f72;">Company</th>
          <th style="text-align:right;padding:4px 10px;border-bottom:2px solid #223f72;">Members</th></tr>
      {rows}
    </table>
  </td></tr>
  <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;color:#94a3b8;font-size:12px;" align="center">
    True Path Sourcing &nbsp;&bull;&nbsp; automated eligibility import</td></tr>
</table></td></tr></table>"""
    client = EmailClient.from_connection_string(cs)
    poller = client.begin_send({
        "senderAddress": frm,
        "content": {"subject": f"Liviniti Eligibility Load — {summary['file_date']} — {summary['rows']:,} rows", "html": html},
        "recipients": {"to": [{"address": to}]},
    })
    print("email:", poller.result().get("status"), "->", to)


def main():
    recreate = os.environ.get("RECREATE") == "1"
    sftp, transport = sftp_connect()
    attrs = sftp.listdir_attr(REMOTE)
    files = []
    for a in attrs:
        m = FNAME_RE.match(a.filename)
        if m:
            files.append((a.filename, m.group(1).strip(), m.group(2)))
    if not files:
        sys.exit("no RxCompass eligibility files found in " + REMOTE)
    target = os.environ.get("LIVINITI_DATE") or max(f[2] for f in files)
    batch = sorted([f for f in files if f[2] == target], key=lambda f: f[1].lower())
    print(f"target batch date {target}: {len(batch)} files")

    cn = db(); logcn = db(autocommit=True)
    cur, logcur = cn.cursor(), logcn.cursor()
    run_at = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    log_id = logcur.execute(
        "INSERT INTO dbo.Client_Import_Log (client_key, group_name, feed_name, target_table, file_name, status) "
        "OUTPUT INSERTED.id VALUES ('liviniti','RxCompass (Liviniti)','Eligibility',?,?, 'Running')",
        TABLE, f"RxCompass Elig {target} ({len(batch)} files)").fetchone()[0]

    # header/columns from the first file
    first = batch[0][0]
    with sftp.open(REMOTE + "/" + first, "rb") as fh:
        header = next(csv.reader(io.StringIO(fh.read(8192).decode("utf-8-sig", "replace"))))
    cols = ensure_table(cur, header, recreate)
    cn.commit()

    total, ok, per_co, errors = 0, 0, [], []
    for i, (fn, co, d) in enumerate(batch, 1):
        try:
            with sftp.open(REMOTE + "/" + fn, "rb") as fh:
                data = fh.read()
            n = load_file(cur, cols, data, fn, co, d)
            cn.commit()
            total += n; ok += 1; per_co.append((co, n))
            if i % 25 == 0 or i == len(batch):
                print(f"  [{i}/{len(batch)}] {co}: {n} rows (running total {total:,})")
        except Exception as e:
            cn.rollback()
            errors.append(f"{fn}: {type(e).__name__}: {e}")
            print(f"  ERROR {fn}: {e}", file=sys.stderr)

    status = "Success" if not errors else ("Partial" if ok else "Error")
    logcur.execute(
        "UPDATE dbo.Client_Import_Log SET status=?, rows_loaded=?, finished_at=GETDATE(), message=? WHERE id=?",
        status, total, f"{ok}/{len(batch)} files, {total} rows"[:3900], log_id)

    per_co.sort(key=lambda x: x[1], reverse=True)
    summary = {"status": status, "file_date": target, "files_total": len(batch), "files_ok": ok,
               "rows": total, "run_at": run_at, "top": per_co[:20], "errors": errors}
    print(f"DONE: {status} — {ok}/{len(batch)} files, {total:,} rows")
    try:
        send_email(summary)
    except Exception as e:
        print("email failed:", e, file=sys.stderr)

    cur.close(); cn.close(); logcur.close(); logcn.close()
    sftp.close(); transport.close()


if __name__ == "__main__":
    main()
