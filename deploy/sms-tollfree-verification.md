# Toll-Free SMS Verification — TruePath Sourcing

**Number:** +1 866 561 7622 (toll-free, US) — ACS resource `acs-tpcrm-sms`, RG `rg-tpcrm-shared`,
subscription `7166b785-9254-4943-9d61-62e668b7ca58`.

**Status (2026-08-07):** Toll-free verification application **SUBMITTED** — now pending carrier
review (typically 1–3+ weeks). Until approved, US/Canada carriers block toll-free SMS, so outbound
texts send but do not deliver (confirmed pre-submission: 8 probe texts 7/23–8/03, 0 Delivered). The
watcher `caj-tpcrm-sms-watch` will email WATCH_EMAIL automatically the moment a probe delivers.

**Open internal item:** how member SMS consent is actually captured/recorded is still under internal
review. The opt-in page (`deploy/sms-optin-mockup.html`) is a mockup for the application only — it is
NOT hosted/functional and should not be wired live until the consent-capture approach is decided.

**Where to submit:** Azure Portal → `acs-tpcrm-sms` → Phone numbers → +18665617622 →
Features panel → **"submit application"** link. (NOT "Regulatory Documents" — that blade is for
regulated-country ID docs and is correctly empty for US toll-free.)

---

## Application field values

**Business**
- Legal business name: `[TruePath Sourcing LLC — confirm exact legal entity]`
- Website: `[https://truepathsourcing.com — confirm]`
- Address: `[business mailing address]`
- Contact: Bill Walker / bill@workflowinnovators.com / `[callback #]`

**Use case**
- Category: Account Notifications / Customer Care (NOT marketing)
- Monthly volume: `[e.g. 2,000–5,000/mo]`; daily peak `[e.g. 500]`
- Summary:
  > TruePath Sourcing operates a pharmacy-benefit member CRM. Texts are transactional member-care
  > outreach to individuals already enrolled in a client employer/plan's pharmacy benefit — e.g.,
  > eligibility confirmations, benefit/program notifications, and clinical outreach (such as GLP-1
  > program availability). Messages go only to existing members; no promotional or third-party content.

**Sample messages**
1. `True Path Sourcing: A new pharmacy savings program may be available on your benefit. Reply YES to have a care advocate contact you, or STOP to opt out.`
2. `True Path Sourcing: We're confirming your pharmacy benefit eligibility. Questions? Call [number]. Reply STOP to opt out.`

**Opt-in (the #1 rejection cause — be specific)**
- Type: Existing business/enrollment relationship — members provide their phone number and consent
  to program communications when they enroll in their employer/plan's pharmacy benefit.
- Evidence to attach: `[enrollment form language OR member-portal consent checkbox that authorizes SMS
  — a screenshot or URL of that page dramatically improves approval odds]`

**Opt-out**
- `STOP` unsubscribes; `HELP` returns support info (already in the message footer).

---

## After approval
The watcher `caj-tpcrm-sms-watch` (cron `0 14 */2 * *`) probes +16153059285 every 2 days and emails
WATCH_EMAIL the moment a probe returns Delivered. No action needed — it will confirm go-live
automatically. Typical carrier review: 1–3+ weeks.
