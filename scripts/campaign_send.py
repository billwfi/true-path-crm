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
from azure.core.exceptions import HttpResponseError

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


def _message_id(poller):
    """Message id from the send's initial response — immediate, no network wait.

    We deliberately do NOT fall back to poller.result() (pollUntilDone): that call
    blocks 10-30s per email and, worse, can hang indefinitely with no timeout,
    stalling the whole batch. Delivery/bounce/open are correlated by this id via the
    email-events webhook; if it's ever missing the email still sends.
    """
    try:
        body = poller.polling_method()._initial_response.http_response.text()
        return json.loads(body).get("id")
    except Exception:
        return None


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

    # retry_total=0 so an HTTP 429 (ACS PerSubscriptionPerHour send limit) surfaces
    # immediately instead of azure-core silently sleeping on its Retry-After header
    # (often ~1 hour) — that sleep is what looked like a "hang" and killed the jobs.
    # Explicit connect/read timeouts stop any single request from blocking forever.
    client = EmailClient.from_connection_string(
        os.environ["ACS_CONNECTION_STRING"],
        connection_timeout=15, read_timeout=30, retry_total=0)

    def db_run(sqltext, *params, fetch=False):
        """Run a statement, reconnecting + retrying on a dropped SQL connection (08S01)."""
        nonlocal cn, cur
        for attempt in range(4):
            try:
                c = cur.execute(sqltext, *params)
                return c.fetchone() if fetch else None
            except pyodbc.Error:
                if attempt == 3:
                    raise
                try:
                    cn.close()
                except Exception:
                    pass
                time.sleep(2 * (attempt + 1))
                cn = db()
                cur = cn.cursor()

    sent = failed = 0
    throttle_after = None  # Retry-After seconds if ACS rate-limits us mid-run
    for r in rows:
        rid, fn, ln, email = r.id, r.first_name, r.last_name, r.email
        name = " ".join([x for x in [fn, ln] if x]).strip() or "Member"
        html = render(html_body, name, email)
        # 1) send via ACS (fast; delivery/bounce finalized by the email-events webhook).
        try:
            poller = client.begin_send({
                "senderAddress": from_addr,
                "content": {"subject": subject, "html": html},
                "recipients": {"to": [{"address": email, "displayName": name}]},
            })
            rstatus, mid, err = "Sent", _message_id(poller), None
        except HttpResponseError as e:
            # Hit the hourly send limit — stop now and leave this + the rest Pending
            # so they go out in the next window. Don't mark anything Failed.
            if e.status_code == 429:
                hdrs = getattr(getattr(e, "response", None), "headers", None) or {}
                try:
                    throttle_after = int(hdrs.get("Retry-After") or hdrs.get("retry-after") or 3700)
                except (TypeError, ValueError):
                    throttle_after = 3700
                break
            rstatus, mid, err = "Failed", None, str(e)[:400]
        except Exception as e:  # noqa: BLE001
            rstatus, mid, err = "Failed", None, str(e)[:400]
        # 2) record — survives DB connection drops so the email isn't lost/double-sent.
        if rstatus == "Sent":
            sent += 1
            db_run("UPDATE dbo.Email_Campaign_Recipients SET status='Sent', message_id=?, "
                   "sent_at=GETDATE(), error=NULL WHERE id=?", mid, rid)
        else:
            failed += 1
            db_run("UPDATE dbo.Email_Campaign_Recipients SET status='Failed', error=? WHERE id=?", err, rid)
        if DELAY:
            time.sleep(DELAY)

    rem = db_run("SELECT COUNT(*) FROM dbo.Email_Campaign_Recipients "
                 "WHERE campaign_id=? AND status='Pending'", CAMPAIGN_ID, fetch=True)[0]
    db_run("UPDATE dbo.Email_Campaigns SET status=?, sent_at=COALESCE(sent_at,GETDATE()) WHERE id=?",
           "Sending" if rem > 0 else "Sent", CAMPAIGN_ID)
    extra = f" throttled retry_after={throttle_after}" if throttle_after else ""
    print(f"[{today}] done: sent={sent} failed={failed} remaining={rem}{extra}")


if __name__ == "__main__":
    main()
