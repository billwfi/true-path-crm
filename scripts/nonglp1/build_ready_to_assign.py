"""Non-GLP1 "Ready to Assign" pipeline.

Rule: claims -> active eligibility -> client-approved formulary.
For each client that has an approved formulary (tp_client_formulary via
tp_clients.uf_company_id), find recent NON-GLP1 claims (dbo.ClaimsData_Prod) where
  (a) the member has ACTIVE eligibility (dbo.eligibility, coverage not ended), and
  (b) the claimed drug (by normalized NDC) is on the client's approved formulary,
and insert them into dbo.ReadyToAssign as category='NONGLP1' (deduped by member+drug).
GLP1 keeps using the existing eligibility->claims process; this is its non-GLP1 peer.

Env: IRX_DB_PWD.  Usage:
  python scripts/nonglp1/build_ready_to_assign.py [--client TPTEST] [--days 365]
"""
import os
import re
import sys
import json
import pyodbc
from datetime import date, datetime, timedelta

GLP1_LIKE = ['ozempic', 'wegovy', 'mounjaro', 'zepbound', 'trulicity', 'rybelsus', 'victoza',
             'saxenda', 'byetta', 'bydureon', 'soliqua', 'xultophy', 'semaglutide', 'tirzepatide',
             'dulaglutide', 'liraglutide', 'exenatide']


def norm_ndc(s):
    return re.sub(r'\D', '', s or '')


def parse_date(s):
    """dateofservice is free-text varchar: try M/D/YYYY then ISO (YYYY-MM-DD...)."""
    if isinstance(s, (date, datetime)):
        return s.date() if isinstance(s, datetime) else s
    s = (s or '').strip()
    if not s:
        return None
    for fmt in ('%m/%d/%Y', '%m/%d/%y'):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    try:
        return datetime.strptime(s[:10], '%Y-%m-%d').date()
    except ValueError:
        return None


def arg(name, default=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def db():
    return pyodbc.connect(
        'DRIVER={ODBC Driver 17 for SQL Server};SERVER=tcp:74.117.224.152,1433;DATABASE=iRx;'
        'UID=claudeservices;PWD=' + os.environ['IRX_DB_PWD'] +
        ';Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=120', autocommit=True)


def main():
    only_client = arg('--client')
    days = int(arg('--days', '365'))
    cur = db().cursor()

    clients = cur.execute(
        """SELECT cl.irx_client_id, cl.uf_company_id, f.products_json, cl.name
           FROM dbo.tp_clients cl JOIN dbo.tp_client_formulary f ON f.company_id = cl.uf_company_id
           WHERE NULLIF(cl.irx_client_id,'') IS NOT NULL
             AND (? IS NULL OR cl.irx_client_id = ?)""", only_client, only_client).fetchall()
    print(f"clients with formulary: {len(clients)}")

    total = 0
    for carrier, company_id, prods_json, cname in clients:
        try:
            prod_ids = [int(x) for x in json.loads(prods_json)] if prods_json else []
        except Exception:
            prod_ids = []
        if not prod_ids:
            continue
        # approved (normalized) NDCs for this client's products
        approved = set()
        for i in range(0, len(prod_ids), 400):
            chunk = prod_ids[i:i + 400]
            q = "SELECT ndc, ndc_comp FROM dbo.tp_products WHERE source_id IN (%s)" % ','.join('?' * len(chunk))
            for ndc, ndc_comp in cur.execute(q, *chunk).fetchall():
                if ndc:
                    approved.add(norm_ndc(ndc))
                if ndc_comp:
                    try:
                        arr = json.loads(ndc_comp)
                        for x in (arr if isinstance(arr, list) else [arr]):
                            approved.add(norm_ndc(str(x)))
                    except Exception:
                        approved.add(norm_ndc(ndc_comp))
        approved.discard('')
        if not approved:
            continue
        # Recent claims for this client. IMPORTANT: query on clientid ALONE — this seeks the
        # clientid index (fast). Adding ANY residual predicate here (date parse, ndc-not-null,
        # the GLP1 NOT LIKE list) makes the optimizer flip to a full 309k-row heap scan that
        # never returns on this slow remote server. So every filter below runs in Python.
        claims = cur.execute(
            """SELECT c.patientid, c.patientlastname, c.patientfirstname, c.patientdateofbirth,
                      c.ndc, c.drugname, c.dateofservice, c.dayssupply, c.quantitydispensed,
                      c.pharmacyname, c.groupid, c.clientname
               FROM dbo.ClaimsData_Prod c WHERE c.clientid = ?""", carrier).fetchall()
        cutoff = date.today() - timedelta(days=days)
        n = 0
        elig_cache = {}
        seen = set()
        for cl in claims:
            if not norm_ndc(cl.ndc):
                continue  # no NDC
            dsv = parse_date(cl.dateofservice)
            if dsv is None or dsv < cutoff:
                continue  # outside the lookback window
            dl = (cl.drugname or '').lower()
            if any(g in dl for g in GLP1_LIKE):
                continue  # GLP1 drug -> handled by the GLP1 pipeline, not here
            key = ((cl.patientid or '').strip(), (cl.drugname or '').strip())
            if key in seen:
                continue  # dedup within this run (member + drug)
            seen.add(key)
            if norm_ndc(cl.ndc) not in approved:
                continue  # drug not on the client's approved formulary
            mid = (cl.patientid or '').strip()
            if mid not in elig_cache:
                elig_cache[mid] = cur.execute(
                    """SELECT TOP 1 1 FROM dbo.eligibility e WHERE e.MEMBER_ID=?
                       AND (NULLIF(e.MEMBER_THRU_DATE,'') IS NULL
                            OR COALESCE(TRY_CONVERT(date,e.MEMBER_THRU_DATE,101),TRY_CONVERT(date,LEFT(e.MEMBER_THRU_DATE,10),23))
                               >= CAST(GETDATE() AS date))""", mid).fetchone() is not None
            if not elig_cache[mid]:
                continue  # member not actively eligible
            if cur.execute("SELECT 1 FROM dbo.ReadyToAssign WHERE category='NONGLP1' AND Member_ID=? AND Drug_Name=?",
                           cl.patientid, cl.drugname).fetchone():
                continue
            cur.execute(
                """INSERT INTO dbo.ReadyToAssign
                   (category,Group_Code,Group_Name,Member_ID,Claim_Patient_ID,Last_Name,First_Name,Date_of_Birth,
                    Gender,Date_of_Service,NDC,Drug_Name,Fill_Number,Quantity_Dispensed,Days_Supply,Pharmacy_Name,status,created_at)
                   VALUES ('NONGLP1',?,?,?,?,?,?,?,'',?,?,?,'1',?,?,?,'Ready to Assign',GETDATE())""",
                cl.groupid or carrier, cl.clientname or cname, cl.patientid, cl.patientid,
                cl.patientlastname, cl.patientfirstname, cl.patientdateofbirth,
                cl.dateofservice, cl.ndc, cl.drugname, cl.quantitydispensed, cl.dayssupply, cl.pharmacyname)
            n += 1
        if n:
            print(f"  {carrier} ({cname}): +{n} non-GLP1 ready-to-assign")
        total += n
    print(f"TOTAL inserted: {total}")


if __name__ == '__main__':
    main()
