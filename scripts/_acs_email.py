"""Send application email through Azure Communication Services.

One place for every job/script to send from, so the whole application uses the
verified ACS sender (noreply@truepathsourcing.com) rather than O365 SMTP. That
matters for deliverability as well as consistency: the tenant's
"TruePath ACS noreply - skip spam filtering" transport rule matches on the
noreply@truepathsourcing.com sender, so mail sent this way bypasses EOP spam
filtering. Mail sent as a mailbox (SMTP) does not.

Env:
  ACS_CONNECTION_STRING   required — the ACS resource connection string
  EMAIL_FROM              verified sender (default noreply@truepathsourcing.com)
  ACS_EMAIL_MAX_TRIES     429 retry attempts (default 8)
"""
import os
import time

DEFAULT_FROM = 'noreply@truepathsourcing.com'


def _fail(msg, raise_on_error):
    print(f"email: FAILED - {msg}")
    if raise_on_error:
        raise RuntimeError(f"email send failed: {msg}")
    return False


def _recipients(to):
    """Accept a list, or a string with comma/semicolon separated addresses."""
    if isinstance(to, (list, tuple, set)):
        items = list(to)
    else:
        items = str(to or '').replace(';', ',').split(',')
    return [a.strip() for a in items if str(a).strip()]


def send_email(to, subject, html, sender=None, cc=None, dry=False, attachments=None,
               raise_on_error=True):
    """Send one email. Returns True when ACS reports Succeeded.

    Raises RuntimeError if the send fails, so a job that cannot email fails
    loudly rather than exiting 0 with nobody notified (which is what smtplib
    used to do). Pass raise_on_error=False for best-effort sends.

    Rides out ACS 429s (the PerSubscriptionPerHour limit is shared with the
    marketing campaign job) rather than failing the run outright.
    """
    addrs = _recipients(to)
    if not addrs:
        return _fail('no recipient; nothing sent', raise_on_error)
    if dry:
        print(f"[dry-run] would email {', '.join(addrs)}: {subject}")
        return True

    cs = os.environ.get('ACS_CONNECTION_STRING')
    if not cs:
        return _fail('no ACS_CONNECTION_STRING; cannot send', raise_on_error)

    from azure.communication.email import EmailClient
    from azure.core.exceptions import HttpResponseError

    frm = sender or os.environ.get('EMAIL_FROM', DEFAULT_FROM)
    # retry_total=0 so a 429 surfaces here instead of azure-core silently
    # sleeping on a ~1h Retry-After.
    client = EmailClient.from_connection_string(cs, retry_total=0)
    payload = {
        'senderAddress': frm,
        'content': {'subject': subject, 'html': html},
        'recipients': {'to': [{'address': a} for a in addrs]},
    }
    if _recipients(cc):
        payload['recipients']['cc'] = [{'address': a} for a in _recipients(cc)]
    # attachments: [(filename, content_type, bytes), ...]
    if attachments:
        import base64
        payload['attachments'] = [{
            'name': name,
            'contentType': ctype or 'application/octet-stream',
            'contentInBase64': base64.b64encode(data).decode('ascii'),
        } for (name, ctype, data) in attachments]

    tries = int(os.environ.get('ACS_EMAIL_MAX_TRIES', '8'))
    for attempt in range(tries):
        try:
            status = client.begin_send(payload).result().get('status')
            print(f"email: {status} -> {', '.join(addrs)}")
            if status == 'Succeeded':
                return True
            return _fail(f"ACS returned {status}", raise_on_error)
        except HttpResponseError as e:
            if getattr(e, 'status_code', None) == 429 and attempt < tries - 1:
                hdrs = getattr(getattr(e, 'response', None), 'headers', {}) or {}
                wait = int(hdrs.get('Retry-After') or hdrs.get('retry-after') or 60)
                wait = max(30, min(wait, 90))
                print(f"email: 429 throttled; retry {attempt + 1}/{tries} in {wait}s")
                time.sleep(wait)
                continue
            return _fail(f"{', '.join(addrs)}: {str(e)[:160]}", raise_on_error)
    return _fail('exhausted retries', raise_on_error)
