"""One-off diagnostic: probe the Liviniti Public API and report the egress IP.

Run from the NAT jobs env (cae-tpcrm-jobs, egress 104.46.113.57) to test whether
our ApiKey authenticates from the IP Liviniti was asked to allowlist. Compares a
real-key call against a no-key call on the same well-formed request: if the real
key returns anything other than 401 while no-key returns 401, the key is live.

Env: LIV_KEY (ApiKey), LIV_GROUP (groupId, default TP958025),
     LIV_BASE (default https://public.liviniti.com/api/v1.0)
"""
import json
import os
import urllib.request
import urllib.error

KEY = os.environ.get("LIV_KEY", "")
GROUP = os.environ.get("LIV_GROUP", "TP958025")
BASE = os.environ.get("LIV_BASE", "https://public.liviniti.com/api/v1.0")


def egress():
    try:
        with urllib.request.urlopen("https://api.ipify.org", timeout=15) as r:
            return r.read().decode()
    except Exception as e:  # noqa: BLE001
        return "unknown (%s)" % e


def call(path, body, key=True):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    if key and KEY:
        req.add_header("ApiKey", KEY)
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, r.read(500).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read(500).decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return "ERR", "%s: %s" % (type(e).__name__, e)


def main():
    print("EGRESS_IP =", egress())
    print("KEY_SET   =", bool(KEY), "GROUP =", GROUP)
    tests = [
        ("DrugSearch  well-formed + REAL key", "/Drug/DrugSearch",
            {"drugName": "atorvastatin"}, True),
        ("DrugSearch  well-formed + NO   key", "/Drug/DrugSearch",
            {"drugName": "atorvastatin"}, False),
        ("Pricing     well-formed + REAL key", "/Pricing/GetPricingByDrugName",
            {"groupId": GROUP, "drugName": "atorvastatin", "strength": "10 mg",
             "dosageForm": "tablet", "quantity": 30, "daysSupply": 30}, True),
        ("Eligibility well-formed + REAL key", "/Eligibility/FetchMemberEligibility",
            {"groupId": GROUP, "planId": GROUP, "cardholderId": "000000000",
             "personCode": "01", "dateOfBirth": "1970-01-01"}, True),
    ]
    for label, path, body, key in tests:
        s, b = call(path, body, key)
        print("RESULT | %-38s -> %s | %s" % (label, s, (b or "").strip()[:180]))
    print("DONE")


if __name__ == "__main__":
    main()
