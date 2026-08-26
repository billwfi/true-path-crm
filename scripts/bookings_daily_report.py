"""Daily scheduler-registration report.

Emails a list of the previous day's new scheduler registrations (rows added to
dbo.Bookings) to the scheduling team. Columns mirror the app's Registrations
view: WHEN (appointment slot), COMPANY, NAME, DOB, PHONE, EMAIL, BOOKED.

The DB server runs in Eastern time and Bookings.created_at is stored Eastern, so
"the previous day" is computed in Central time (DST-safe via AT TIME ZONE) to
match the 6am CT delivery.

Usage:
  python scripts/bookings_daily_report.py           # yesterday (Central), the daily run
  python scripts/bookings_daily_report.py --test     # last 60 days, subject tagged [TEST]

Env: IRX_DB_PWD, SMTP_HOST/PORT/USER/SMTP_PASS/MAIL_FROM,
     REPORT_TO (default scheduler@truepathsourcing.com)
"""
import os
import sys
import smtplib
from email.mime.text import MIMEText

import pyodbc

REPORT_TO = os.environ.get("REPORT_TO", "scheduler@truepathsourcing.com")
# The OnBase team always receives the daily recap too (in addition to REPORT_TO).
ALWAYS_TO = "onbasesupport@internationalrx.com"


def recipients():
    r = [a.strip() for a in REPORT_TO.split(",") if a.strip()]
    if ALWAYS_TO not in r:
        r.append(ALWAYS_TO)
    return r

# created_at is Eastern-local; shift Eastern -> Central so the day window and the
# BOOKED column line up with a Central-time reader.
CENTRAL = "AT TIME ZONE 'Eastern Standard Time' AT TIME ZONE 'Central Standard Time'"


def db():
    return pyodbc.connect(
        "DRIVER={ODBC Driver 17 for SQL Server};SERVER=tcp:74.117.224.152,1433;"
        f"DATABASE={os.environ.get('SQLSERVER_DB','iRx')};UID=claudeservices;"
        f"PWD={os.environ['IRX_DB_PWD']};Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=30",
        autocommit=True)


def fetch(cur, test):
    # BOOKED, filter day, and "yesterday" all expressed in Central time.
    booked_central = f"CAST(b.created_at {CENTRAL} AS datetime)"
    sql = f"""
        SELECT b.slot_start, b.company_name, b.first_name, b.last_name, b.name,
               b.dob, b.phone, b.email, b.lang, {booked_central} AS booked_ct, s.name AS scheduler
        FROM dbo.Bookings b
        LEFT JOIN dbo.Booking_Schedulers s ON s.id = b.scheduler_id
        {{where}}
        ORDER BY b.slot_start ASC, b.id ASC
    """
    if test:
        where = f"WHERE {booked_central} >= DATEADD(day, -60, CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Central Standard Time' AS datetime))"
    else:
        where = (f"WHERE CAST(b.created_at {CENTRAL} AS date) = "
                 "CAST(DATEADD(day, -1, CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Central Standard Time' AS date)) AS date)")
    return cur.execute(sql.format(where=where)).fetchall()


def yday_central(cur):
    return cur.execute(
        "SELECT CAST(DATEADD(day,-1,CAST(SYSDATETIMEOFFSET() AT TIME ZONE 'Central Standard Time' AS date)) AS date)"
    ).fetchone()[0]


def mdY(d):
    return f"{d.month}/{d.day}/{d.year}" if d else ""


def when(dt):
    if not dt:
        return ""
    h = ((dt.hour + 11) % 12) + 1
    ap = "AM" if dt.hour < 12 else "PM"
    return (f'<div style="font-weight:600">{dt.month}/{dt.day}/{dt.year}</div>'
            f'<div style="color:#64748b;font-size:12px">{h}:{dt.minute:02d} {ap}</div>')


def esc(v):
    s = "" if v is None else str(v)
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def build_html(rows, subtitle, test):
    th = ('padding:11px 14px;text-align:left;font-size:11px;font-weight:700;letter-spacing:.06em;'
          'text-transform:uppercase;color:#64748b;border-bottom:2px solid #e2e8f0')
    td = "padding:13px 14px;font-size:14px;color:#0f172a;border-bottom:1px solid #eef2f6;vertical-align:top"
    head = "".join(f'<th style="{th}">{h}</th>' for h in
                   ["When", "Company", "Name", "DOB", "Phone", "Email", "Language", "Booked"])

    # Group registrants under their scheduler, preserving first-seen order.
    groups = {}
    for r in rows:
        key = r[10] or "(no scheduler)"
        groups.setdefault(key, []).append(r)

    def row_html(r):
        slot, company, fn, ln, name, dob, phone, email, lang, booked, sched = r
        nm = (f"{(fn or '').strip()} {(ln or '').strip()}".strip()) or (name or "")
        em = (f'<a href="mailto:{esc(email)}" style="color:#2563eb;text-decoration:none">{esc(email)}</a>'
              if email else '<span style="color:#94a3b8">—</span>')
        lg = ('<b style="color:#b45309">Español</b>' if (lang or "").lower().startswith("es")
              else '<span style="color:#64748b">English</span>')
        return (f'<tr>'
                f'<td style="{td}">{when(slot)}</td>'
                f'<td style="{td}">{esc(company) or "—"}</td>'
                f'<td style="{td};font-weight:600">{esc(nm)}</td>'
                f'<td style="{td}">{mdY(dob)}</td>'
                f'<td style="{td};font-variant-numeric:tabular-nums">{esc(phone) or "—"}</td>'
                f'<td style="{td}">{em}</td>'
                f'<td style="{td}">{lg}</td>'
                f'<td style="{td};color:#475569">{mdY(booked)}</td>'
                f'</tr>')

    if rows:
        sections = []
        for sched, grp in groups.items():
            body = "".join(row_html(r) for r in grp)
            sections.append(
                f'<div style="margin:0 0 22px">'
                f'<div style="display:flex;align-items:baseline;gap:10px;margin:0 2px 8px">'
                f'<h2 style="font-size:15px;margin:0;color:#0f172a">{esc(sched)}</h2>'
                f'<span style="font-size:12px;color:#64748b">{len(grp)} new registrant(s)</span></div>'
                f'<table style="border-collapse:collapse;width:100%;background:#fff;'
                f'border:1px solid #e2e8f0;border-radius:10px;overflow:hidden">'
                f'<thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>')
        table = "".join(sections)
    else:
        table = ('<div style="padding:26px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;'
                 'color:#64748b;font-size:14px">No new registrations for this period.</div>')
    banner = ('<div style="margin:0 0 16px;padding:10px 14px;background:#fef9c3;border:1px solid #fde047;'
              'border-radius:8px;color:#854d0e;font-size:13px;font-weight:600">TEST EMAIL — verifying '
              'delivery to the scheduling distribution list. Contains recent registrations for reference.</div>'
              ) if test else ""
    return f"""<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
        background:#f1f5f9;padding:26px;color:#0f172a">
      <div style="max-width:860px;margin:0 auto">
        {banner}
        <h1 style="font-size:20px;margin:0 0 4px">New Scheduler Registrations</h1>
        <p style="margin:0 0 18px;color:#475569;font-size:14px">{subtitle} &middot; {len(rows)} registration(s)</p>
        {table}
        <p style="margin:18px 2px 0;color:#94a3b8;font-size:12px">
          True Path Sourcing &middot; automated daily report &middot; source: Schedulers &rsaquo; Registrations</p>
      </div>
    </div>"""


def send(html, subject):
    to = recipients()
    msg = MIMEText(html, "html")
    msg["Subject"] = subject
    msg["From"] = os.environ["MAIL_FROM"]
    msg["To"] = ", ".join(to)
    with smtplib.SMTP(os.environ.get("SMTP_HOST", "smtp.office365.com"),
                      int(os.environ.get("SMTP_PORT", "587"))) as s:
        s.starttls()
        s.login(os.environ["SMTP_USER"], os.environ["SMTP_PASS"])
        s.sendmail(msg["From"], to, msg.as_string())


def main():
    test = "--test" in sys.argv
    cn = db(); cur = cn.cursor()
    rows = fetch(cur, test)
    if test:
        subtitle = "Recent registrations (last 60 days)"
        subject = f"[TEST] New Scheduler Registrations — {len(rows)} recent"
    else:
        day = yday_central(cur)
        subtitle = f"For {mdY(day)}"
        subject = f"New Scheduler Registrations — {mdY(day)} ({len(rows)})"
    html = build_html(rows, subtitle, test)
    send(html, subject)
    print(f"Sent '{subject}' to {', '.join(recipients())} ({len(rows)} rows)")


if __name__ == "__main__":
    main()
