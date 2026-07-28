"""Liviniti (RxCompass) eligibility SFTP importer — RECONCILING load.

Pulls the newest weekly batch of per-company eligibility CSVs, stages them, then
reconciles into dbo.Eligibility_Liviniti (NEVER truncates):
  - member new in the file            -> INSERT (LoadStatus='Active')
  - member in file AND table          -> UPDATE (refresh; LoadStatus='Active'; reactivate)
  - member in table, NOT in the file, for a group that WAS in the file
                                       -> mark LoadStatus='Inactive'
Groups absent from this week's file are left untouched (the feed just didn't include
them). Member identity = (GroupID, CardholderID, PersonCode).

Emails a branded TruePath summary with per-group Added / Updated / Inactivated counts.

Env: LIVINITI_SFTP_PWD, IRX_DB_PWD, ACS_CONNECTION_STRING, EMAIL_TO, EMAIL_FROM,
     LIVINITI_DATE (optional YYYY-MM-DD)
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
STG = "Eligibility_Liviniti_Stg"
FNAME_RE = re.compile(r"^RxCompass (.+) Elig (\d{4}-\d{2}-\d{2})\.csv$", re.I)
COPY_EXTRA = ["SourceFile", "CompanyName", "FileDate"]
# Member identity = GroupID|CardholderID|PersonCode, as a bounded persisted computed
# column (the base columns are NVARCHAR(4000) and can't be indexed directly).
MEMBERKEY_EXPR = ("(ISNULL(CONVERT(NVARCHAR(60),GroupID),'')+'|'+"
                  "ISNULL(CONVERT(NVARCHAR(120),CardholderID),'')+'|'+"
                  "ISNULL(CONVERT(NVARCHAR(20),PersonCode),''))")
KEY = "t.MemberKey = s.MemberKey"
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


def ensure_schema(cur, cols):
    coldefs = ",\n  ".join(f"[{c}] NVARCHAR(4000) NULL" for c in cols)
    mk = f"[MemberKey] AS {MEMBERKEY_EXPR} PERSISTED"
    # Main table: create with status columns + MemberKey if missing; else add what's missing.
    if cur.execute(f"SELECT OBJECT_ID('dbo.{TABLE}','U')").fetchone()[0] is None:
        cur.execute(
            f"CREATE TABLE dbo.[{TABLE}] (\n  {coldefs},\n"
            "  [SourceFile] NVARCHAR(260) NULL, [CompanyName] NVARCHAR(200) NULL, [FileDate] DATE NULL,\n"
            "  [LoadStatus] NVARCHAR(20) NOT NULL DEFAULT 'Active',\n"
            "  [LoadedAt] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),\n"
            f"  [UpdatedAt] DATETIME2 NULL, [InactivatedAt] DATETIME2 NULL,\n  {mk})")
    else:
        for col, ddl in [("LoadStatus", "NVARCHAR(20) NOT NULL DEFAULT 'Active'"),
                         ("UpdatedAt", "DATETIME2 NULL"), ("InactivatedAt", "DATETIME2 NULL")]:
            if cur.execute(f"SELECT COL_LENGTH('dbo.{TABLE}','{col}')").fetchone()[0] is None:
                cur.execute(f"ALTER TABLE dbo.[{TABLE}] ADD [{col}] {ddl}")
        if cur.execute(f"SELECT COL_LENGTH('dbo.{TABLE}','MemberKey')").fetchone()[0] is None:
            cur.execute(f"ALTER TABLE dbo.[{TABLE}] ADD {mk}")
    # Staging table: recreate fresh each run (guarantees MemberKey present).
    cur.execute(f"IF OBJECT_ID('dbo.{STG}','U') IS NOT NULL DROP TABLE dbo.[{STG}]")
    cur.execute(f"CREATE TABLE dbo.[{STG}] (\n  {coldefs},\n"
                "  [SourceFile] NVARCHAR(260) NULL, [CompanyName] NVARCHAR(200) NULL, [FileDate] DATE NULL,\n"
                f"  {mk})")
    # MemberKey indexes.
    for tbl, ix in [(TABLE, "IX_Elig_Liv_mk"), (STG, "IX_Elig_Liv_Stg_mk")]:
        if cur.execute(f"SELECT 1 FROM sys.indexes WHERE name='{ix}'").fetchone() is None:
            cur.execute(f"CREATE INDEX {ix} ON dbo.[{tbl}] (MemberKey)")


def load_stg(cur, cols, data, filename, company, file_date):
    reader = csv.reader(io.StringIO(data.decode("utf-8-sig", "replace")))
    try:
        next(reader)
    except StopIteration:
        return 0
    ncol = len(cols)
    collist = ", ".join(f"[{c}]" for c in cols) + ", [SourceFile], [CompanyName], [FileDate]"
    ph = ", ".join("?" for _ in range(ncol + 3))
    sqltxt = f"INSERT INTO dbo.[{STG}] ({collist}) VALUES ({ph})"
    cur.fast_executemany = True
    buf, total = [], 0
    for row in reader:
        cells = [(row[i] if i < len(row) else None) for i in range(ncol)]
        cells = [(c if (c is not None and c != "") else None) for c in cells]
        buf.append(cells + [filename[:260], company[:200], file_date])
        if len(buf) >= BATCH:
            cur.executemany(sqltxt, buf); total += len(buf); buf = []
    if buf:
        cur.executemany(sqltxt, buf); total += len(buf)
    return total


def reconcile(cur, cols):
    copy = cols + COPY_EXTRA
    # Per-group counts BEFORE any DML (consistent snapshot).
    def bygroup(q):
        return {r.gid: r.n for r in cur.execute(q).fetchall()}
    added = bygroup(f"SELECT s.GroupID gid, COUNT(*) n FROM dbo.[{STG}] s "
                    f"WHERE NOT EXISTS (SELECT 1 FROM dbo.[{TABLE}] t WHERE {KEY}) GROUP BY s.GroupID")
    updated = bygroup(f"SELECT s.GroupID gid, COUNT(*) n FROM dbo.[{STG}] s "
                      f"WHERE EXISTS (SELECT 1 FROM dbo.[{TABLE}] t WHERE {KEY}) GROUP BY s.GroupID")
    inactivated = bygroup(
        f"SELECT t.GroupID gid, COUNT(*) n FROM dbo.[{TABLE}] t "
        f"WHERE t.LoadStatus='Active' AND t.GroupID IN (SELECT DISTINCT GroupID FROM dbo.[{STG}]) "
        f"AND NOT EXISTS (SELECT 1 FROM dbo.[{STG}] s WHERE {KEY}) GROUP BY t.GroupID")

    # Apply: update matched, insert new, inactivate dropped.
    set_list = ", ".join(f"t.[{c}]=s.[{c}]" for c in copy)
    cur.execute(f"UPDATE t SET {set_list}, t.LoadStatus='Active', t.UpdatedAt=SYSUTCDATETIME(), t.InactivatedAt=NULL "
                f"FROM dbo.[{TABLE}] t JOIN dbo.[{STG}] s ON {KEY}")
    ins_cols = ", ".join(f"[{c}]" for c in copy)
    sel_cols = ", ".join(f"s.[{c}]" for c in copy)
    cur.execute(f"INSERT INTO dbo.[{TABLE}] ({ins_cols}, LoadStatus) SELECT {sel_cols}, 'Active' "
                f"FROM dbo.[{STG}] s WHERE NOT EXISTS (SELECT 1 FROM dbo.[{TABLE}] t WHERE {KEY})")
    cur.execute(f"UPDATE t SET t.LoadStatus='Inactive', t.InactivatedAt=SYSUTCDATETIME() FROM dbo.[{TABLE}] t "
                f"WHERE t.LoadStatus='Active' AND t.GroupID IN (SELECT DISTINCT GroupID FROM dbo.[{STG}]) "
                f"AND NOT EXISTS (SELECT 1 FROM dbo.[{STG}] s WHERE {KEY})")

    # Group name lookup for the email.
    names = {r.GroupID: (r.gn, r.cn) for r in cur.execute(
        f"SELECT GroupID, MAX(GroupName) gn, MAX(CompanyName) cn FROM dbo.[{STG}] GROUP BY GroupID").fetchall()}
    gids = set(added) | set(updated) | set(inactivated)
    rows = []
    for g in gids:
        gn, cn = names.get(g, (None, None))
        rows.append({"group": gn or cn or g, "gid": g,
                     "added": added.get(g, 0), "updated": updated.get(g, 0), "inactivated": inactivated.get(g, 0)})
    rows.sort(key=lambda r: r["added"] + r["inactivated"], reverse=True)
    return rows, {"added": sum(added.values()), "updated": sum(updated.values()), "inactivated": sum(inactivated.values())}


def send_email(summary):
    cs = os.environ.get("ACS_CONNECTION_STRING")
    if not cs:
        print("no ACS_CONNECTION_STRING; skipping email"); return
    from azure.communication.email import EmailClient
    to = os.environ.get("EMAIL_TO", "liviniti@truepathsourcing.com")
    frm = os.environ.get("EMAIL_FROM", "noreply@truepathsourcing.com")
    changed = [r for r in summary["rows"] if r["added"] or r["inactivated"] or r["updated"]]
    body_rows = "".join(
        f"<tr><td style='padding:4px 10px;border-bottom:1px solid #eee;'>{r['group']}</td>"
        f"<td style='padding:4px 10px;border-bottom:1px solid #eee;text-align:right;color:#0a7d3c;'>{r['added']:,}</td>"
        f"<td style='padding:4px 10px;border-bottom:1px solid #eee;text-align:right;color:#475569;'>{r['updated']:,}</td>"
        f"<td style='padding:4px 10px;border-bottom:1px solid #eee;text-align:right;color:#b91c1c;'>{r['inactivated']:,}</td></tr>"
        for r in changed[:60])
    t = summary["totals"]
    html = f"""<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5f5;padding:24px 0;font-family:Arial,Helvetica,sans-serif;"><tr><td align="center">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
  <tr><td style="background:#223f72;padding:20px 32px;" align="center">
    <img src="https://app.truepathsourcing.com/assets/img/truepath-logo-white.png" alt="True Path Sourcing" width="200" style="display:block;max-width:200px;height:auto;"></td></tr>
  <tr><td style="padding:28px 32px;color:#1e293b;font-size:15px;line-height:1.6;">
    <p style="margin:0 0 12px;font-size:19px;font-weight:700;color:#0a5e57;">Liviniti / RxCompass Eligibility — Reconciliation</p>
    <p style="margin:0 0 6px;"><b>Status:</b> {summary['status']} &nbsp;&bull;&nbsp; <b>Batch date:</b> {summary['file_date']} &nbsp;&bull;&nbsp; <b>Files:</b> {summary['files_ok']}/{summary['files_total']}</p>
    <p style="margin:0 0 16px;"><b>Added:</b> <span style="color:#0a7d3c;font-weight:700;">{t['added']:,}</span> &nbsp;
       <b>Updated:</b> <span style="color:#475569;font-weight:700;">{t['updated']:,}</span> &nbsp;
       <b>Inactivated:</b> <span style="color:#b91c1c;font-weight:700;">{t['inactivated']:,}</span> &nbsp;
       <span style="color:#94a3b8;">(run {summary['run_at']} UTC)</span></p>
    <p style="margin:16px 0 6px;font-weight:600;">Changes by group{' (top 60)' if len(changed)>60 else ''}</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;font-size:13px;border-collapse:collapse;">
      <tr><th style="text-align:left;padding:4px 10px;border-bottom:2px solid #223f72;">Group</th>
          <th style="text-align:right;padding:4px 10px;border-bottom:2px solid #223f72;">Added</th>
          <th style="text-align:right;padding:4px 10px;border-bottom:2px solid #223f72;">Updated</th>
          <th style="text-align:right;padding:4px 10px;border-bottom:2px solid #223f72;">Inactivated</th></tr>
      {body_rows or '<tr><td colspan=4 style="padding:10px;color:#94a3b8;">No changes this run.</td></tr>'}
    </table>
  </td></tr>
  <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;color:#94a3b8;font-size:12px;" align="center">
    True Path Sourcing &nbsp;&bull;&nbsp; automated eligibility reconciliation &nbsp;&bull;&nbsp; dbo.Eligibility_Liviniti</td></tr>
</table></td></tr></table>"""
    client = EmailClient.from_connection_string(cs)
    poller = client.begin_send({
        "senderAddress": frm,
        "content": {"subject": f"Liviniti Eligibility — {summary['file_date']} — +{t['added']:,} / ~{t['updated']:,} / -{t['inactivated']:,}", "html": html},
        "recipients": {"to": [{"address": to}]}})
    print("email:", poller.result().get("status"), "->", to)


def main():
    sftp, transport = sftp_connect()
    files = []
    for a in sftp.listdir_attr(REMOTE):
        m = FNAME_RE.match(a.filename)
        if m:
            files.append((a.filename, m.group(1).strip(), m.group(2)))
    if not files:
        sys.exit("no RxCompass eligibility files found")
    target = os.environ.get("LIVINITI_DATE") or max(f[2] for f in files)
    batch = sorted([f for f in files if f[2] == target], key=lambda f: f[1].lower())
    print(f"target batch {target}: {len(batch)} files")

    cn = db(); logcn = db(autocommit=True)
    cur, logcur = cn.cursor(), logcn.cursor()
    run_at = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
    log_id = logcur.execute(
        "INSERT INTO dbo.Client_Import_Log (client_key, group_name, feed_name, target_table, file_name, status) "
        "OUTPUT INSERTED.id VALUES ('liviniti','RxCompass (Liviniti)','Eligibility Reconcile',?,?, 'Running')",
        TABLE, f"RxCompass Elig {target} ({len(batch)} files)").fetchone()[0]

    with sftp.open(REMOTE + "/" + batch[0][0], "rb") as fh:
        header = next(csv.reader(io.StringIO(fh.read(8192).decode("utf-8-sig", "replace"))))
    cols = [sanitize(h) for h in header]

    ensure_schema(cur, cols); cn.commit()

    ok, errors = 0, []
    for i, (fn, co, d) in enumerate(batch, 1):
        try:
            with sftp.open(REMOTE + "/" + fn, "rb") as fh:
                data = fh.read()
            load_stg(cur, cols, data, fn, co, d); cn.commit(); ok += 1
            if i % 50 == 0 or i == len(batch):
                print(f"  staged [{i}/{len(batch)}]")
        except Exception as e:
            cn.rollback(); errors.append(f"{fn}: {type(e).__name__}: {e}")
            print(f"  ERROR staging {fn}: {e}", file=sys.stderr)

    rows, totals = reconcile(cur, cols); cn.commit()
    status = "Success" if not errors else "Partial"
    logcur.execute("UPDATE dbo.Client_Import_Log SET status=?, rows_loaded=?, finished_at=GETDATE(), message=? WHERE id=?",
                   status, totals["added"] + totals["updated"],
                   f"{ok}/{len(batch)} files; +{totals['added']} ~{totals['updated']} -{totals['inactivated']}"[:3900], log_id)

    summary = {"status": status, "file_date": target, "files_total": len(batch), "files_ok": ok,
               "run_at": run_at, "rows": rows, "totals": totals}
    print(f"DONE: {status} — added={totals['added']} updated={totals['updated']} inactivated={totals['inactivated']}")
    try:
        send_email(summary)
    except Exception as e:
        print("email failed:", e, file=sys.stderr)

    cur.close(); cn.close(); logcur.close(); logcn.close()
    sftp.close(); transport.close()


if __name__ == "__main__":
    main()
