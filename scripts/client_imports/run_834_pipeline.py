"""End-to-end 834 pipeline for scheduled runs: pull the newest 834 from SFTP,
parse it into staging, then reconcile into dbo.eligibility (and email the AMT
report). This is the entrypoint the weekly Container Apps Job runs.

Steps: SFTP newest file matching the client's pattern -> parse_834.py -> reconcile.py

Usage:
  python scripts/client_imports/run_834_pipeline.py anders

Env:
  IRX_DB_PWD    (required)  SQL Server password
  SFTP_PWD      (required)  SFTP password (SFTPCloud MANAGER)
  RECON_FLAGS   (default "--commit --send")  passed to reconcile.py
  SMTP_HOST/PORT/USER/SMTP_PASS/MAIL_FROM  for --send
"""
import fnmatch
import os
import subprocess
import sys
import tempfile

import paramiko

HERE = os.path.dirname(os.path.abspath(__file__))

# Per-client 834 SFTP feed (same SFTPCloud account as the CSV feeds).
SFTP_834 = {
    "anders": {
        "host": "us-east-1.sftpcloud.io", "port": 22, "user": "MANAGER",
        "remote_dir": "/InternationalRx/Anders", "pattern": "AndersGroupLLC_*.txt",
    },
}


def pull_newest(cfg, dest_dir):
    pwd = os.environ.get("SFTP_PWD") or os.environ.get("MCR_SFTP_PWD")
    if not pwd:
        sys.exit("Missing SFTP password (SFTP_PWD)")
    t = paramiko.Transport((cfg["host"], cfg["port"]))
    t.connect(username=cfg["user"], password=pwd)
    try:
        s = paramiko.SFTPClient.from_transport(t)
        matches = [a for a in s.listdir_attr(cfg["remote_dir"])
                   if fnmatch.fnmatch(a.filename, cfg["pattern"])]
        if not matches:
            sys.exit(f"No file matching {cfg['pattern']} in {cfg['remote_dir']}")
        newest = max(matches, key=lambda a: a.st_mtime)
        local = os.path.join(dest_dir, newest.filename)
        s.get(cfg["remote_dir"].rstrip("/") + "/" + newest.filename, local)
        print(f"  pulled {newest.filename} ({newest.st_size} bytes) from {cfg['remote_dir']}")
        return local
    finally:
        t.close()


def run(*args):
    print(f"  $ {' '.join(os.path.basename(a) for a in args[1:])}")
    subprocess.run(args, check=True, cwd=os.path.dirname(os.path.dirname(HERE)))


def main():
    client = sys.argv[1] if len(sys.argv) > 1 else "anders"
    cfg = SFTP_834.get(client)
    if not cfg:
        sys.exit(f"Unknown 834 client '{client}'. Known: {', '.join(SFTP_834)}")
    for v in ("IRX_DB_PWD",):
        if not os.environ.get(v):
            sys.exit(f"Missing env var {v}")

    flags = os.environ.get("RECON_FLAGS", "--commit --send").split()
    print(f"== 834 pipeline: {client} ==")
    with tempfile.TemporaryDirectory() as tmp:
        local = pull_newest(cfg, tmp)
        run(sys.executable, os.path.join(HERE, "parse_834.py"), client, local)
        run(sys.executable, os.path.join(HERE, "reconcile.py"), client, *flags)
    print("== done ==")


if __name__ == "__main__":
    main()
