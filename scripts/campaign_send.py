"""Scheduled drip sender for an email campaign (Container Apps Job, PIPELINE=campaign).

Each run: look up today's cap in CAMPAIGN_RAMP (the job fires at 15:00 UTC = 10:00
America/Chicago CDT, so the UTC date equals the Central date). Send up to that many
Pending recipients for CAMPAIGN_ID via ACS Email, updating status per recipient so a
timeout/restart never double-sends. Delivery/bounce/open are tracked separately by the
email-events Event Grid webhook.

Env: IRX_DB_PWD, ACS_CONNECTION_STRING, JWT_SECRET, EMAIL_FROM, CAMPAIGN_ID,
     CAMPAIGN_RAMP (JSON {"YYYY-MM-DD": cap}), SEND_DELAY_MS, DRY_RUN
"""
import os
import json
import time
import hmac
import hashlib
from datetime import datetime, timezone
from urllib.parse import quote

import pyodbc
from azure.communication.email import EmailClient

CAMPAIGN_ID = int(os.environ.get("CAMPAIGN_ID", "1"))
EMAIL_FROM = os.environ.get("EMAIL_FROM", "noreply@truepathsourcing.com")
DELAY = int(os.environ.get("SEND_DELAY_MS", "200")) / 1000.0
DRY_RUN = os.environ.get("DRY_RUN", "").strip().lower() in ("1", "true", "yes")
RAMP = json.loads(os.environ.get("CAMPAIGN_RAMP", "{}"))


def db():
    cs = ("DRIVER={ODBC Driver 17 for SQL Server};SERVER=74.117.224.152;DATABASE=iRx;"
          f"UID=claudeservices;PWD={os.environ['IRX_DB_PWD']};Encrypt=yes;TrustServerCertificate=yes;")
    return pyodbc.connect(cs, autocommit=True)


def unsub_url(email):
    secret = os.environ.get("JWT_SECRET", "tp-unsub").encode()
    tok = hmac.new(secret, email.strip().lower().encode(), hashlib.sha256).hexdigest()[:20]
    return "https://app.truepathsourcing.com/unsubscribe/?e=" + quote(email) + "&t=" + tok


def render(html, name, email):
    return (html.replace("{{member_name}}", name or "Member")
                .replace("{{unsubscribe_url}}", unsub_url(email)))


def main():
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    cap = RAMP.get(today)
    if not cap:
        print(f"[{today}] no send scheduled today (date not in CAMPAIGN_RAMP); exiting.")
        return
    cap = int(cap)

    cn = db()
    cur = cn.cursor()
    camp = cur.execute(
        "SELECT status, template_en, from_address FROM dbo.Email_Campaigns WHERE id=?", CAMPAIGN_ID).fetchone()
    if not camp:
        print(f"campaign {CAMPAIGN_ID} not found; exiting.")
        return
    status, tkey, from_addr = camp
    if status == "Paused":
        print(f"[{today}] campaign {CAMPAIGN_ID} is Paused; exiting.")
        return
    from_addr = from_addr or EMAIL_FROM

    tpl = cur.execute("SELECT subject, html_body FROM dbo.Email_Templates WHERE tkey=?", tkey).fetchone()
    if not tpl:
        print(f"template {tkey} not found; exiting.")
        return
    subject, html_body = tpl

    # Honor opt-outs recorded since import.
    cur.execute("UPDATE dbo.Email_Campaign_Recipients SET status='Suppressed' "
                "WHERE campaign_id=? AND status='Pending' "
                "AND LOWER(email) IN (SELECT email FROM dbo.Email_OptOut)", CAMPAIGN_ID)

    rows = cur.execute(
        "SELECT TOP (?) id, first_name, last_name, email "
        "FROM dbo.Email_Campaign_Recipients "
        "WHERE campaign_id=? AND status='Pending' ORDER BY id", cap, CAMPAIGN_ID).fetchall()

    print(f"[{today}] campaign={CAMPAIGN_ID} cap={cap} selected={len(rows)} dry_run={DRY_RUN}")
    if DRY_RUN:
        for r in rows[:8]:
            print("  would send ->", r.email)
        print(f"  ... {len(rows)} total this run")
        return

    client = EmailClient.from_connection_string(os.environ["ACS_CONNECTION_STRING"])
    sent = failed = 0
    for r in rows:
        rid, fn, ln, email = r.id, r.first_name, r.last_name, r.email
        name = " ".join([x for x in [fn, ln] if x]).strip() or "Member"
        html = render(html_body, name, email)
        try:
            poller = client.begin_send({
                "senderAddress": from_addr,
                "content": {"subject": subject, "html": html},
                "recipients": {"to": [{"address": email, "displayName": name}]},
            })
            res = poller.result()
            if res.get("status") == "Succeeded":
                sent += 1
                cur.execute("UPDATE dbo.Email_Campaign_Recipients SET status='Sent', message_id=?, "
                            "sent_at=GETDATE(), error=NULL WHERE id=?", res.get("id"), rid)
            else:
                failed += 1
                cur.execute("UPDATE dbo.Email_Campaign_Recipients SET status='Failed', error=? WHERE id=?",
                            str(res.get("status"))[:400], rid)
        except Exception as e:  # noqa: BLE001 — record and continue
            failed += 1
            cur.execute("UPDATE dbo.Email_Campaign_Recipients SET status='Failed', error=? WHERE id=?",
                        str(e)[:400], rid)
        if DELAY:
            time.sleep(DELAY)

    rem = cur.execute("SELECT COUNT(*) FROM dbo.Email_Campaign_Recipients "
                      "WHERE campaign_id=? AND status='Pending'", CAMPAIGN_ID).fetchone()[0]
    cur.execute("UPDATE dbo.Email_Campaigns SET status=?, sent_at=COALESCE(sent_at,GETDATE()) WHERE id=?",
                "Sending" if rem > 0 else "Sent", CAMPAIGN_ID)
    print(f"[{today}] done: sent={sent} failed={failed} remaining={rem}")


if __name__ == "__main__":
    main()
