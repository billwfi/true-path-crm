"""Monday import orchestrator + summary report.

1. Runs every due/active Import_Configs feed via import_worker (unless --report-only).
2. Scans the whole client SFTP tree and cross-references against the active loaders
   and the processed-file log, so any folder/file WITHOUT a working loader — or with
   a new file not yet loaded — is surfaced (nothing silently missed).
3. Emails an HTML summary to REPORT_TO via O365 SMTP.

Env:
  IRX_DB_PWD        SQL password (user claudeservices)
  MCR_SFTP_PWD      SFTP password for us-east-1.sftpcloud.io / MANAGER (tree scan)
  IMPORT_CRYPT_KEY  needed by import_worker to decrypt per-config SFTP creds
  SMTP_HOST/PORT/USER/SMTP_PASS/MAIL_FROM   O365 relay
  REPORT_TO         report recipient (default bill@workflowinnovators.com)

Usage:
  python scripts/import_monday.py                # run loaders + report
  python scripts/import_monday.py --report-only  # scan + email only, no loading
"""
import argparse
import fnmatch
import os
import smtplib
import stat
import subprocess
import sys
from datetime import datetime
from email.mime.text import MIMEText

import paramiko
import pyodbc

SFTP_HOST, SFTP_USER, SFTP_ROOT = "us-east-1.sftpcloud.io", "MANAGER", "/InternationalRx"
# Folders that are one-off / ad-hoc drops — listed for manual review, never auto-loaded.
ADHOC = {"DHR", "CityOfBonham"}
# Registry-pipeline clients (sftp_import.py + reconcile.py) folded into the Monday
# run so they share the unified schedule + report. Their SFTP folders count as
# covered in the coverage scan (they DO have a loader, just not a config-driven one).
REGISTRY_CLIENTS = ["mcrhotels"]
REGISTRY_FOLDERS = ["/InternationalRx/MCRHotels"]
# Folders whose files are superseded/stale — excluded from the coverage gap list.
# Any */Archive holds rotated-out files; Ridgecrest/incoming (lowercase) is a stale
# duplicate of the live Ridgecrest/Incoming/incoming loader.


def is_ignored(folder):
    fl = folder.lower().rstrip("/")
    return "/archive" in fl or fl.endswith("/ridgecrest/incoming")


def db():
    cs = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=tcp:74.117.224.152,1433;DATABASE=iRx;"
          f"UID=claudeservices;PWD={os.environ['IRX_DB_PWD']};Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=30;")
    return pyodbc.connect(cs, autocommit=True)


def load_configs(cur):
    """Active configs, tagged 'ready' when they have the maps needed to actually run."""
    cur.execute("""
        SELECT c.id, c.name, c.feed_type, c.remote_dir, c.file_pattern, c.active, c.last_run_at,
               (SELECT COUNT(*) FROM dbo.Import_Column_Maps m WHERE m.config_id=c.id) cmaps,
               (SELECT COUNT(*) FROM dbo.Import_Reconcile_Maps r WHERE r.config_id=c.id) rmaps
        FROM dbo.Import_Configs c""")
    cols = [d[0] for d in cur.description]
    out = []
    for r in cur.fetchall():
        c = dict(zip(cols, r))
        c["ready"] = bool(c["active"]) and c["cmaps"] > 0 and (c["feed_type"] != "Eligibility" or c["rmaps"] > 0)
        out.append(c)
    return out


def sftp_tree():
    t = paramiko.Transport((SFTP_HOST, 22))
    t.connect(username=SFTP_USER, password=os.environ["MCR_SFTP_PWD"])
    sftp = paramiko.SFTPClient.from_transport(t)
    files = []  # (folder, name, size, mtime)

    def walk(path):
        try:
            entries = sftp.listdir_attr(path)
        except Exception:
            return
        for a in entries:
            full = path.rstrip("/") + "/" + a.filename
            if stat.S_ISDIR(a.st_mode):
                walk(full)
            else:
                files.append((path, a.filename, a.st_size, a.st_mtime))

    walk(SFTP_ROOT)
    t.close()
    return files


def covered_by(folder, name, ready_cfgs):
    """A ready config whose remote_dir matches this folder and pattern matches this file."""
    for c in ready_cfgs:
        rd = (c["remote_dir"] or "").rstrip("/").lower()
        if rd == folder.rstrip("/").lower() and fnmatch.fnmatch(name, c["file_pattern"] or "*"):
            return c
    return None


def esc(s):
    return (str(s) if s is not None else "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_report(configs, files, processed, run_started):
    ready = [c for c in configs if c["ready"]]
    now = datetime.now()

    # Runs recorded since we kicked the worker off (this session's activity).
    def run_rows(cur):
        cur.execute("""SELECT c.name, r.status, r.file_name, r.rows_imported, r.added_count,
                              r.updated_count, r.inactivated_count, r.message, r.started_at
                       FROM dbo.Import_Runs r JOIN dbo.Import_Configs c ON c.id=r.config_id
                       WHERE r.started_at >= ? ORDER BY r.started_at""", run_started)
        return cur.fetchall()

    # Coverage: bucket every SFTP file.
    by_folder = {}
    for folder, name, size, mt in files:
        by_folder.setdefault(folder, []).append((name, size, mt))
    covered_new, uncovered, adhoc = [], [], []
    for folder, name, size, mt in files:
        short = folder.split("/")[-1] or folder
        c = covered_by(folder, name, ready)
        if c:
            if name not in processed.get(c["id"], set()):
                covered_new.append((c["name"], folder, name, mt))  # loader exists, file not yet loaded
        elif any(folder.rstrip("/").lower().startswith(rf.lower()) for rf in REGISTRY_FOLDERS):
            pass  # covered by a registry-pipeline loader (e.g. MCR Hotels)
        elif is_ignored(folder):
            pass  # superseded/stale (Archive, stale dup folders)
        elif any(a.lower() in folder.lower() for a in ADHOC):
            adhoc.append((folder, name, mt))
        else:
            uncovered.append((folder, name, mt))

    def fdate(mt):
        return datetime.utcfromtimestamp(mt).strftime("%Y-%m-%d")

    H = []
    H.append(f"<h2 style='font-family:Segoe UI,Arial;color:#0d7d74'>True Path — Weekly Import Report</h2>")
    H.append(f"<p style='font-family:Segoe UI,Arial;color:#475569'>Run {now:%A %Y-%m-%d %H:%M}. "
             f"{len(ready)} active loader(s); {len(files)} files on SFTP.</p>")

    return H, ready, covered_new, uncovered, adhoc, run_rows, by_folder


def table(rows, headers):
    th = "".join(f"<th style='text-align:left;padding:6px 10px;border-bottom:2px solid #e2e8f0;font:600 12px Segoe UI'>{h}</th>" for h in headers)
    trs = ""
    for r in rows:
        tds = "".join(f"<td style='padding:6px 10px;border-bottom:1px solid #f1f5f9;font:13px Segoe UI;color:#334155'>{c}</td>" for c in r)
        trs += f"<tr>{tds}</tr>"
    return f"<table style='border-collapse:collapse;width:100%'><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--report-only", action="store_true", help="scan + email only; do not run loaders")
    args = ap.parse_args()

    run_started = datetime.now()
    worker_out = ""
    if not args.report_only:
        print("Running import_worker for due configs…")
        p = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "import_worker.py")],
                           capture_output=True, text=True)
        worker_out = (p.stdout or "") + (p.stderr or "")
        print(worker_out)

        # Load registry-format client files into their staging tables. MCR Hotels ships a
        # bespoke roster/claims format (a specific worksheet + a computed group id) that its
        # own loader handles — the same way parse_834 handles Anders. It is then reconciled
        # in the unified loop below, exactly like every other client.
        here = os.path.dirname(__file__)
        for client in REGISTRY_CLIENTS:
            print(f"Loading {client} files…")
            try:
                subprocess.run([sys.executable, os.path.join(here, "client_imports", "sftp_import.py"), client],
                               capture_output=True, text=True, timeout=1800)
            except Exception as e:  # noqa: BLE001 - never let one client fail the whole run
                print(f"  {client} load error: {e}")

        # Claims loaders — add-only append into the per-client claims tables the app reads.
        print("Running claims loaders…")
        try:
            cp = subprocess.run([sys.executable, os.path.join(here, "client_imports", "claims_loader.py")],
                                capture_output=True, text=True, timeout=1800)
            print((cp.stdout or "") + (cp.stderr or ""))
        except Exception as e:  # noqa: BLE001
            print(f"  claims_loader error: {e}")

        # Reconcile every client into ClaimsData_Prod / dbo.eligibility, each with its own
        # per-client reconciliation email. MCR Hotels runs the FULL reconcile (its eligibility
        # feed was loaded above); the rest are claims-only — their eligibility is loaded by
        # separate config feeds (import_worker) or the weekly 834 job.
        reconcile_clients = [("mcrhotels", False)] + [
            (c, True) for c in ("anders", "rha", "cseamericas", "cityofmission", "smithcounty",
                                "greggcounty", "caregiver", "fsg", "mcallen", "harrison")]
        for client, claims_only in reconcile_clients:
            print(f"Reconciling {client}…")
            try:
                cmd = [sys.executable, os.path.join(here, "client_imports", "reconcile.py"),
                       client, "--commit", "--send"]
                if claims_only:
                    cmd.append("--claims-only")
                rp = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
                print((rp.stdout or "") + (rp.stderr or ""))
            except Exception as e:  # noqa: BLE001
                print(f"  {client} reconcile error: {e}")

        # Non-GLP1 "Ready to Assign" build — claims -> active eligibility -> client-approved
        # formulary. Runs after reconcile so ClaimsData_Prod + eligibility are current. Peer
        # of the existing GLP1 eligibility->claims feed; inserts category='NONGLP1' rows.
        print("Building non-GLP1 ready-to-assign…")
        try:
            np = subprocess.run([sys.executable, os.path.join(here, "nonglp1", "build_ready_to_assign.py")],
                                capture_output=True, text=True, timeout=3600)
            print((np.stdout or "") + (np.stderr or ""))
        except Exception as e:  # noqa: BLE001
            print(f"  build_ready_to_assign error: {e}")

        # GLP-1 -> OnBase export (BRIDGE until full cutover): email the OnBase load
        # team (techsupport@) a CSV of new GLP-1 members not yet in OnBase.
        print("Running GLP-1 OnBase export…")
        try:
            gp = subprocess.run([sys.executable, os.path.join(here, "client_imports", "glp1_onbase_export.py")],
                                capture_output=True, text=True, timeout=1800)
            print((gp.stdout or "") + (gp.stderr or ""))
        except Exception as e:  # noqa: BLE001
            print(f"  glp1_onbase_export error: {e}")

    cn = db(); cur = cn.cursor()
    configs = load_configs(cur)
    cur.execute("SELECT config_id, file_name FROM dbo.Import_Processed_Files")
    processed = {}
    for cid, fn in cur.fetchall():
        processed.setdefault(cid, set()).add(fn)

    files = sftp_tree()
    H, ready, covered_new, uncovered, adhoc, run_rows_fn, by_folder = build_report(configs, files, processed, run_started)

    # Section 1 — loaders that ran this session
    if not args.report_only:
        rr = run_rows_fn(cur)
        H.append("<h3 style='font:600 15px Segoe UI;color:#1e293b'>Loaders run this morning</h3>")
        if rr:
            rows = [(esc(r[0]), esc(r[1]), esc(r[2]),
                     "" if r[3] is None else f"{r[3]:,}",
                     "" if r[4] is None else f"+{r[4]} / ~{r[5]} / -{r[6]}",
                     esc((r[7] or "")[:120])) for r in rr]
            H.append(table(rows, ["Loader", "Status", "File", "Rows", "Add/Upd/Inact", "Message"]))
        else:
            H.append("<p style='font:13px Segoe UI;color:#64748b'>No loaders were due to run.</p>")

    # Section 1b — registry-pipeline loaders (MCR Hotels): from Client_Import_Log
    ph = ",".join("?" * len(REGISTRY_CLIENTS))
    cur.execute(f"""SELECT TOP 8 client_key, feed_name, status, rows_loaded, file_name,
                           CONVERT(varchar,finished_at,120)
                    FROM dbo.Client_Import_Log WHERE client_key IN ({ph})
                    ORDER BY id DESC""", *REGISTRY_CLIENTS)
    reg_log = cur.fetchall()
    if reg_log:
        H.append("<h3 style='font:600 15px Segoe UI;color:#1e293b'>Registry-pipeline loaders (MCR Hotels)</h3>")
        H.append(table([(esc(r[0]), esc(r[1]), esc(r[2]), "" if r[3] is None else f"{r[3]:,}",
                         esc((r[4] or "")[:40]), esc(r[5])) for r in reg_log],
                       ["Client", "Feed", "Status", "Rows", "File", "Finished"]))

    # Section 2 — active loader roster
    H.append("<h3 style='font:600 15px Segoe UI;color:#1e293b'>Active loaders</h3>")
    H.append(table([(esc(c["name"]), esc(c["feed_type"]), esc(c["remote_dir"]),
                     c["last_run_at"].strftime("%Y-%m-%d") if c["last_run_at"] else "never") for c in ready],
                   ["Loader", "Type", "Folder", "Last run"]))

    # Section 3 — new files with a loader but not yet loaded
    if covered_new:
        H.append("<h3 style='font:600 15px Segoe UI;color:#b45309'>New files awaiting their next scheduled load</h3>")
        H.append(table([(esc(l), esc(f.split('/')[-1]), esc(n), datetime.utcfromtimestamp(m).strftime('%Y-%m-%d'))
                        for l, f, n, m in covered_new], ["Loader", "Folder", "File", "File date"]))

    # Section 4 — folders/files with NO loader (the gap)
    H.append("<h3 style='font:600 15px Segoe UI;color:#b91c1c'>New files with NO loader (need a loader built)</h3>")
    if uncovered:
        H.append(table([(esc(f.split('/')[-1]), esc(n), datetime.utcfromtimestamp(m).strftime('%Y-%m-%d'))
                        for f, n, m in sorted(uncovered)], ["Folder", "File", "File date"]))
    else:
        H.append("<p style='font:13px Segoe UI;color:#16a34a'>None — every folder's files are covered.</p>")

    # Section 5 — ad-hoc / manual review
    if adhoc:
        H.append("<h3 style='font:600 15px Segoe UI;color:#64748b'>Ad-hoc / manual review (not auto-loaded)</h3>")
        H.append(table([(esc(f.split('/')[-1]), esc(n), datetime.utcfromtimestamp(m).strftime('%Y-%m-%d'))
                        for f, n, m in sorted(adhoc)], ["Folder", "File", "File date"]))

    html = "<div style='max-width:900px'>" + "".join(H) + "</div>"

    to = os.environ.get("REPORT_TO", "amtfileloads@truepathsourcing.com")
    msg = MIMEText(html, "html")
    msg["Subject"] = f"True Path — Weekly Import Report ({run_started:%Y-%m-%d})"
    msg["From"] = os.environ["MAIL_FROM"]
    msg["To"] = to
    with smtplib.SMTP(os.environ.get("SMTP_HOST", "smtp.office365.com"), int(os.environ.get("SMTP_PORT", "587"))) as s:
        s.starttls()
        s.login(os.environ["SMTP_USER"], os.environ["SMTP_PASS"])
        s.sendmail(msg["From"], [a.strip() for a in to.split(",")], msg.as_string())
    print(f"Report emailed to {to}. loaders_ready={len(ready)} uncovered={len(uncovered)} covered_new={len(covered_new)} adhoc={len(adhoc)}")
    cn.close()


if __name__ == "__main__":
    main()
