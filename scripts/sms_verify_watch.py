"""Scheduled watcher for ACS toll-free verification.

Each run: if a probe text to WATCH_TO has come back 'Delivered' (a delivery
report the app's Event Grid webhook recorded on dbo.SMS_Log), the toll-free
number has cleared carrier verification -> email a one-time heads-up and stop.
Otherwise send a fresh probe so the next run has something to check.

Env: IRX_DB_PWD, ACS_CONNECTION_STRING, SMS_FROM, WATCH_TO, WATCH_EMAIL,
     SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
"""
import os
import smtplib
from email.mime.text import MIMEText

import pyodbc
from azure.communication.sms import SmsClient

TO = os.environ.get("WATCH_TO", "+16153059285")
FROM = os.environ.get("SMS_FROM", "+18665617622")
PROBE = "True Path Sourcing: verification check. Reply STOP to opt out."


def db():
    cs = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;DATABASE=iRx;"
          f"UID=claudeservices;PWD={os.environ['IRX_DB_PWD']};Encrypt=yes;TrustServerCertificate=yes;")
    return pyodbc.connect(cs, autocommit=True)


def email(subject, body):
    msg = MIMEText(body)
    msg["Subject"] = subject
    msg["From"] = os.environ.get("MAIL_FROM", os.environ["SMTP_USER"])
    msg["To"] = os.environ["WATCH_EMAIL"]
    with smtplib.SMTP(os.environ["SMTP_HOST"], int(os.environ.get("SMTP_PORT", 587))) as s:
        s.starttls()
        s.login(os.environ["SMTP_USER"], os.environ["SMTP_PASS"])
        s.sendmail(msg["From"], [os.environ["WATCH_EMAIL"]], msg.as_string())


def main():
    cn = db(); cur = cn.cursor()
    cur.execute("IF OBJECT_ID('dbo.SMS_VerifyWatch','U') IS NULL "
                "CREATE TABLE dbo.SMS_VerifyWatch (id INT IDENTITY PRIMARY KEY, notified_at DATETIME)")

    delivered = cur.execute(
        "SELECT COUNT(*) FROM dbo.SMS_Log WHERE to_number=? AND delivery_status='Delivered'", TO).fetchone()[0]
    notified = cur.execute("SELECT COUNT(*) FROM dbo.SMS_VerifyWatch").fetchone()[0]

    if delivered:
        if not notified:
            email("TPS toll-free SMS is verified and live",
                  f"A test text to {TO} was just Delivered — the toll-free number {FROM} has cleared "
                  "carrier verification and member texting is now live. You can stop this watcher.")
            cur.execute("INSERT INTO dbo.SMS_VerifyWatch (notified_at) VALUES (GETDATE())")
            print("VERIFIED -> emailed", os.environ.get("WATCH_EMAIL"))
        else:
            print("already notified; noop")
        return

    # Not verified yet: send a probe (logged so the delivery report can match it).
    client = SmsClient.from_connection_string(os.environ["ACS_CONNECTION_STRING"])
    res = client.send(from_=FROM, to=[TO], message=PROBE, enable_delivery_report=True)
    mid = res[0].message_id if res else None
    cur.execute(
        "INSERT INTO dbo.SMS_Log (to_number, from_number, message, message_id, status) "
        "VALUES (?,?,?,?,'sent')", TO, FROM, PROBE, mid)
    print("not verified yet; probe sent", mid)


if __name__ == "__main__":
    main()
