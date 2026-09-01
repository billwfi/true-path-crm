"""Daily SFTP-import notification — one email per client processed, via Azure ACS.

Reviews the files processed on a given date (config feeds in dbo.Import_Runs plus the
registry-pipeline clients in dbo.Client_Import_Log) and sends ONE branded email per client
that actually had a file, summarising what was loaded. Uses the same ACS setup as the
campaign sender / Liviniti import (no O365 SMTP).

Env:
  IRX_DB_PWD              SQL password (user claudeservices)
  ACS_CONNECTION_STRING   Azure Communication Services connection string
  EMAIL_FROM              verified sender (default noreply@truepathsourcing.com)
  REPORT_TO               recipient (default bill@workflowinnovators.com)

Usage:
  python scripts/import_daily_email.py                 # yesterday
  python scripts/import_daily_email.py --date 2026-08-31
  python scripts/import_daily_email.py --dry-run       # print, don't send
"""
import os
import sys
import pyodbc
from datetime import date, datetime, timedelta


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def db():
    return pyodbc.connect(
        'DRIVER={ODBC Driver 17 for SQL Server};SERVER=tcp:74.117.224.152,1433;DATABASE=iRx;'
        'UID=claudeservices;PWD=' + os.environ['IRX_DB_PWD'] +
        ';Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=60', autocommit=True)


def gather(cur, d):
    """Return {client_name: [item,...]} for files processed on date d.
    item = dict(feed, target, file_name, status, rows, added, updated, inactivated)."""
    clients = {}

    def add(client, item):
        clients.setdefault(client or 'Unknown', []).append(item)

    # Config-driven feeds (Import_Runs) — only rows where a file was actually seen.
    for r in cur.execute(
        """SELECT cl.name client, c.name feed, c.target_table, r.file_name, r.status,
                  r.rows_imported, r.added_count, r.updated_count, r.inactivated_count
           FROM dbo.Import_Runs r
           JOIN dbo.Import_Configs c ON c.id = r.config_id
           LEFT JOIN dbo.tp_clients cl ON cl.id = c.client_id
           WHERE CAST(r.started_at AS date) = ? AND NULLIF(LTRIM(RTRIM(r.file_name)),'') IS NOT NULL
           ORDER BY r.started_at""", d).fetchall():
        add(r.client, dict(feed=r.feed, target=r.target_table, file_name=r.file_name, status=r.status,
                           rows=r.rows_imported, added=r.added_count, updated=r.updated_count,
                           inactivated=r.inactivated_count))

    # Registry-pipeline clients (Client_Import_Log) — MCR Hotels, etc.
    for r in cur.execute(
        """SELECT cl.name client, l.group_name, l.feed_name, l.target_table, l.file_name,
                  l.status, l.rows_loaded
           FROM dbo.Client_Import_Log l LEFT JOIN dbo.tp_clients cl ON cl.id = l.client_id
           WHERE CAST(l.started_at AS date) = ? AND NULLIF(LTRIM(RTRIM(l.file_name)),'') IS NOT NULL
           ORDER BY l.started_at""", d).fetchall():
        add(r.client or r.group_name, dict(feed=r.feed_name, target=r.target_table, file_name=r.file_name,
                                            status=r.status, rows=r.rows_loaded, added=None, updated=None,
                                            inactivated=None))
    return clients


def money_none(v):
    return '' if v is None else f'{int(v):,}'


def client_html(client, items, d):
    rows = []
    for it in items:
        ok = (it['status'] or '').lower() in ('success', 'succeeded')
        badge = ('<span style="color:#0a7d3c;font-weight:700;">Success</span>' if ok
                 else f'<span style="color:#b45309;font-weight:700;">{it["status"] or "—"}</span>')
        breakdown = ''
        if it['added'] is not None or it['updated'] is not None or it['inactivated'] is not None:
            breakdown = (f"<span style='color:#0a7d3c;'>+{money_none(it['added'])}</span> / "
                         f"<span style='color:#475569;'>~{money_none(it['updated'])}</span> / "
                         f"<span style='color:#b91c1c;'>-{money_none(it['inactivated'])}</span>")
        rows.append(
            f"<tr><td style='padding:8px 10px;border-bottom:1px solid #eee;'>{it['file_name']}"
            f"<div style='color:#94a3b8;font-size:12px;'>{it['feed'] or ''} &rarr; {it['target'] or ''}</div></td>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #eee;text-align:right;'>{money_none(it['rows']) or '—'}</td>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #eee;text-align:right;font-size:12px;'>{breakdown or '—'}</td>"
            f"<td style='padding:8px 10px;border-bottom:1px solid #eee;text-align:center;'>{badge}</td></tr>")
    return f"""<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f2f5f5;padding:24px 0;font-family:Arial,Helvetica,sans-serif;"><tr><td align="center">
<table role="presentation" width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
  <tr><td style="background:#223f72;padding:20px 32px;" align="center">
    <img src="https://app.truepathsourcing.com/assets/img/truepath-logo-white.png" alt="True Path Sourcing" width="200" style="display:block;max-width:200px;height:auto;"></td></tr>
  <tr><td style="padding:28px 32px;color:#1e293b;font-size:15px;line-height:1.6;">
    <p style="margin:0 0 6px;font-size:19px;font-weight:700;color:#0a5e57;">{client}</p>
    <p style="margin:0 0 16px;color:#475569;">SFTP files processed on <b>{d:%m/%d/%Y}</b></p>
    <table cellpadding="0" cellspacing="0" style="width:100%;font-size:13px;border-collapse:collapse;">
      <tr><th style="text-align:left;padding:6px 10px;border-bottom:2px solid #223f72;">File</th>
          <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #223f72;">Rows</th>
          <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #223f72;">Added / Updated / Inact.</th>
          <th style="text-align:center;padding:6px 10px;border-bottom:2px solid #223f72;">Status</th></tr>
      {''.join(rows)}
    </table>
  </td></tr>
  <tr><td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 32px;color:#94a3b8;font-size:12px;" align="center">
    True Path Sourcing &nbsp;&bull;&nbsp; automated SFTP import notification</td></tr>
</table></td></tr></table>"""


def send(client, items, d, to, dry):
    ok_count = sum(1 for it in items if (it['status'] or '').lower() in ('success', 'succeeded'))
    subject = f"TruePath SFTP Import — {client} — {d:%m/%d/%Y} ({ok_count}/{len(items)} loaded)"
    if dry:
        print(f"[dry-run] would email {to}: {subject}")
        for it in items:
            print(f"    - {it['file_name']} | {it['feed']} -> {it['target']} | rows={it['rows']} | {it['status']}")
        return True
    cs = os.environ.get('ACS_CONNECTION_STRING')
    if not cs:
        print(f"no ACS_CONNECTION_STRING; cannot send for {client}"); return False
    from azure.communication.email import EmailClient
    frm = os.environ.get('EMAIL_FROM', 'noreply@truepathsourcing.com')
    client_acs = EmailClient.from_connection_string(cs)
    poller = client_acs.begin_send({
        'senderAddress': frm,
        'content': {'subject': subject, 'html': client_html(client, items, d)},
        'recipients': {'to': [{'address': to}]}})
    status = poller.result().get('status')
    print(f"email: {status} -> {to} ({client})")
    return status == 'Succeeded'


def main():
    ds = arg('--date')
    d = datetime.strptime(ds, '%Y-%m-%d').date() if ds else (date.today() - timedelta(days=1))
    to = arg('--to') or os.environ.get('REPORT_TO', 'bill@workflowinnovators.com')
    dry = '--dry-run' in sys.argv

    cur = db().cursor()
    clients = gather(cur, d)
    if not clients:
        print(f"No SFTP files processed on {d}. Nothing to send.")
        return
    print(f"{d}: {len(clients)} client(s) with processed files -> emailing {to}")
    sent = 0
    for client, items in sorted(clients.items()):
        if send(client, items, d, to, dry):
            sent += 1
    print(f"{'previewed' if dry else 'sent'} {sent}/{len(clients)} client email(s)")


if __name__ == '__main__':
    main()
