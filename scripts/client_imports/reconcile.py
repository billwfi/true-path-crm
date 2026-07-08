"""Step 2: reconcile client staging tables into the production eligibility/claims
tables, then build (and optionally email) the AMT reconciliation report.

Runs AFTER sftp_import.py has loaded the staging tables. DRY-RUN by default —
it prints what it would do and writes nothing. Add --commit to perform the
eligibility/claims writes, and --send to email the report.

Eligibility (staging -> dbo.eligibility, keyed CARRIER + MEMBER_ID):
  - in file & in eligibility ....... keep; AccountStatus='Active'
  - in file, not in eligibility .... INSERT (GroupName, LoadUpdateDate=today, AccountStatus='Active')
  - in eligibility, not in file .... MEMBER_THRU_DATE=today, AccountStatus='Inactive', LoadUpdateDate=today

Claims (staging -> dbo.ClaimsData_Prod, add-only, keyed on clientid + like cols):
  - map the columns that line up (raw NCPDP -> prod), leave the rest NULL
  - insert only claims not already present for this client

Usage:
  python scripts/client_imports/reconcile.py mcrhotels                 # dry run
  python scripts/client_imports/reconcile.py mcrhotels --commit        # write to prod
  python scripts/client_imports/reconcile.py mcrhotels --commit --send # write + email AMT

Env: IRX_DB_PWD (required). For --send: SMTP_HOST, SMTP_PORT (default 587),
SMTP_USER, SMTP_PASS, MAIL_FROM.
"""
import argparse
import os
import sys
import smtplib
from datetime import date
from email.mime.text import MIMEText

import pyodbc

AMT_RECIPIENTS = ["bwalker@truepathsourcing.com"]
GLP1_LIKE = ["ozemp", "wegov", "mounjaro", "zepbound", "semaglu", "tirze"]


# ── Per-client reconcile config ──────────────────────────────────────────────
# eligibility.map: eligibility_col -> stage_col, or ("left1", stage_col) / ("const", value)
# claims.map:      prod_col -> stage_col (rest of prod stays NULL). "map what you can."
RECON = {
    "mcrhotels": {
        "client_id": 23,
        "carrier": "76416172",
        "group_name": "MCR Hotels",
        "eligibility": {
            "stage_table": "Eligibility_MCRHotels",
            "stage_key": "Person_Id",           # -> eligibility.MEMBER_ID
            "map": {
                "MEMBER_ID": "Person_Id",
                "PERSON_CODE": "Person_Code",
                "RELATIONSHIP_CODE": "Relationship",
                "LAST_NAME": "Last_Name",
                "FIRST_NAME": "First_Name",
                "MIDDLE_INITIAL": ("left1", "Middle_Name"),
                "SEX": "Gender",
                "DATE_OF_BIRTH": "Date_Of_Birth",
                "ADDRESS_1": "Address1",
                "ADDRESS_2": "Address2",
                "CITY": "City",
                "STATE": "State",
                "ZIP": "Zip",
                "PHONE": "Home_Phone",
                "EMail_Address": "Email_Address",
                "MEMBER_FROM_DATE": "Effective_Start",
                # MEMBER_THRU_DATE left NULL for adds (file's Effective_End is a
                # coverage month, not a term date); set only on inactivation.
            },
            "report_join": ("Group_Id", "Person_Id"),  # stage cols = (CARRIER, MEMBER_ID)
        },
        "claims": {
            "stage_table": "ClaimsData_MCRHotels",
            "target": "ClaimsData_Prod",
            "clientid": "76416172",
            "clientname": "MCR Hotels",
            "map": {  # prod_col -> stage_col (columns that line up; rest NULL)
                "groupid": "Group_ID",
                "dateofservice": "Date_of_Service",
                "ndc": "Product_ID",
                "drugname": "Product_Service_Description",
                "quantitydispensed": "QuantityDispensed",
                "dayssupply": "DaysSupply",
                "compound": "Compound_Indicator",
                "maintenancedrugflag": "Maintenance_Drug_Flag",
                "pharmacynpi": "Pharmacy_NPI",
                "pharmacyname": "Pharmacy_Name",
                "pharmacystate": "Pharmacy_State",
                "patientid": "Patient_ID",
                "patientrelationshipcode": "Patient_Relationship_Code",
                "patientlastname": "Patient_Last_Name",
                "patientfirstname": "Patient_First_Name",
                "patientdateofbirth": "Patient_DOB",
                "age": "Patient_Age",
            },
            # add-only dedupe: a claim already present for this client
            "key": ["patientid", "dateofservice", "ndc", "quantitydispensed",
                    "dayssupply", "pharmacynpi"],
        },
    },
}


def db_connect(autocommit=False):
    conn = (
        "DRIVER={ODBC Driver 17 for SQL Server};"
        f"SERVER={os.environ.get('SQLSERVER_HOST', '74.117.224.152')};"
        f"DATABASE={os.environ.get('SQLSERVER_DB', 'irx')};"
        f"UID={os.environ.get('SQLSERVER_USER', 'claudeservices')};"
        "PWD=" + os.environ["IRX_DB_PWD"] + ";"
        "Encrypt=yes;TrustServerCertificate=yes;"
    )
    return pyodbc.connect(conn, autocommit=autocommit)


def norm(v):
    return "" if v is None else str(v).strip()


# ── Eligibility reconcile ─────────────────────────────────────────────────────
def eligibility_reconcile(cur, cfg, commit):
    e = cfg["eligibility"]
    carrier, gname = cfg["carrier"], cfg["group_name"]
    today = date.today()
    stage_cols = []
    for tgt, src in e["map"].items():
        stage_cols.append(src[1] if isinstance(src, tuple) else src)
    sel = ", ".join(f"[{c}]" for c in dict.fromkeys(stage_cols))
    rows = cur.execute(f"SELECT {sel} FROM dbo.[{e['stage_table']}]").fetchall()
    colidx = {c: i for i, c in enumerate(dict.fromkeys(stage_cols))}

    def val(row, src):
        if isinstance(src, tuple):
            raw = norm(row[colidx[src[1]]])
            return raw[:1] if src[0] == "left1" else raw
        return norm(row[colidx[src]])

    file_members = {}      # MEMBER_ID -> row
    for r in rows:
        mid = norm(r[colidx[e["stage_key"]]])
        if mid:
            file_members[mid] = r

    ex = cur.execute(
        "SELECT MEMBER_ID, AccountStatus FROM dbo.eligibility WHERE CARRIER=?", carrier).fetchall()
    existing = {norm(r[0]): norm(r[1]) for r in ex}

    adds = [m for m in file_members if m not in existing]
    matched = [m for m in file_members if m in existing]
    terms = [m for m in existing
             if m and m not in file_members and (existing[m] or "").lower() != "inactive"]

    inactive_in_file = sum(1 for r in rows if norm(r[colidx.get("Active", -1)]) == "0") \
        if "Active" in colidx else None

    print(f"  Eligibility: {len(file_members)} in file | "
          f"{len(adds)} add, {len(matched)} matched(->Active), {len(terms)} term(->Inactive)")

    if not commit:
        for m in adds[:3]:
            print(f"      + add   {m}  {val(file_members[m], e['map']['LAST_NAME'])}, "
                  f"{val(file_members[m], e['map']['FIRST_NAME'])}")
        return {"adds": len(adds), "matched": len(matched), "terms": len(terms)}

    # INSERT adds
    ins_cols = list(e["map"].keys()) + ["CARRIER", "GroupName", "LoadUpdateDate", "AccountStatus"]
    collist = ", ".join(f"[{c}]" for c in ins_cols)
    ph = ", ".join("?" for _ in ins_cols)
    ins_rows = []
    for m in adds:
        row = file_members[m]
        vals = [val(row, e["map"][c]) or None for c in e["map"]]
        vals += [carrier, gname, today, "Active"]
        ins_rows.append(tuple(vals))
    cur.fast_executemany = True
    if ins_rows:
        cur.executemany(f"INSERT INTO dbo.eligibility ({collist}) VALUES ({ph})", ins_rows)
    # matched -> Active
    if matched:
        cur.executemany("UPDATE dbo.eligibility SET AccountStatus='Active' WHERE CARRIER=? AND MEMBER_ID=?",
                        [(carrier, m) for m in matched])
    # terms -> Inactive + thru date
    if terms:
        cur.executemany(
            "UPDATE dbo.eligibility SET MEMBER_THRU_DATE=?, AccountStatus='Inactive', LoadUpdateDate=? "
            "WHERE CARRIER=? AND MEMBER_ID=?",
            [(today.strftime("%m/%d/%Y"), today, carrier, m) for m in terms])
    return {"adds": len(adds), "matched": len(matched), "terms": len(terms)}


# ── Claims reconcile (add-only) ──────────────────────────────────────────────
def claims_reconcile(cur, cfg, commit):
    c = cfg["claims"]
    today = date.today()
    src_cols = list(dict.fromkeys(c["map"].values()))
    sel = ", ".join(f"[{s}]" for s in src_cols)
    rows = cur.execute(f"SELECT {sel} FROM dbo.[{c['stage_table']}]").fetchall()
    sidx = {s: i for i, s in enumerate(src_cols)}

    def prod_val(row, prod_col):
        if prod_col == "clientid":
            return c["clientid"]
        if prod_col == "clientname":
            return c["clientname"]
        src = c["map"].get(prod_col)
        return norm(row[sidx[src]]) if src else None

    # existing keys for this client only
    keycols = c["key"]
    ksel = ", ".join(f"[{k}]" for k in keycols)
    ex = cur.execute(
        f"SELECT {ksel} FROM dbo.[{c['target']}] WHERE clientid=?", c["clientid"]).fetchall()
    seen = {tuple(norm(v) for v in r) for r in ex}

    prod_cols = ["clientid", "clientname"] + list(c["map"].keys()) + ["LoadUpdateDate"]
    collist = ", ".join(f"[{p}]" for p in prod_cols)
    ph = ", ".join("?" for _ in prod_cols)

    new_rows, dups, local = [], 0, set()
    for r in rows:
        key = tuple(norm(prod_val(r, k)) for k in keycols)
        if key in seen or key in local:
            dups += 1
            continue
        local.add(key)
        vals = [prod_val(r, p) for p in c["map"].keys()]
        new_rows.append(tuple([c["clientid"], c["clientname"]] + vals + [today]))

    print(f"  Claims: {len(rows)} in file | {len(new_rows)} new, {dups} already present "
          f"({len(seen)} existing for client)")

    if commit and new_rows:
        cur.fast_executemany = True
        cur.executemany(f"INSERT INTO dbo.[{c['target']}] ({collist}) VALUES ({ph})", new_rows)
    return {"new": len(new_rows), "dups": dups}


# ── AMT reconciliation report (adapted from the Gregg County query) ──────────
def build_report(cur, cfg):
    e, c = cfg["eligibility"], cfg["claims"]
    ca, mi = e["report_join"]
    glp1 = " OR ".join(f"a.drugname LIKE '%{k}%'" for k in GLP1_LIKE)
    sql = f"""
    SELECT DISTINCT 'Eligibility - Adds' AS loadcategory, a.GroupName AS grp, a.LAST_NAME AS last_name, a.FIRST_NAME AS first_name, a.LoadUpdateDate AS d
    FROM dbo.eligibility a
      JOIN dbo.[{e['stage_table']}] x ON x.[{ca}] = a.CARRIER AND x.[{mi}] = a.MEMBER_ID
    WHERE CONVERT(date, a.LoadUpdateDate, 101) = CONVERT(date, GETDATE(), 101)
    UNION
    SELECT DISTINCT 'Eligibility - Terms', a.GroupName, a.LAST_NAME, a.FIRST_NAME, a.LoadUpdateDate
    FROM dbo.eligibility a
      LEFT JOIN dbo.[{e['stage_table']}] x ON x.[{ca}] = a.CARRIER AND x.[{mi}] = a.MEMBER_ID
    WHERE a.CARRIER = ? AND CONVERT(date, a.LoadUpdateDate, 101) = CONVERT(date, GETDATE(), 101) AND x.[{mi}] IS NULL
    UNION
    SELECT DISTINCT 'Claims - GLP1 - Adds', a.clientname, a.patientlastname, a.patientfirstname, a.LoadUpdateDate
    FROM dbo.[{c['target']}] a
    WHERE a.clientid = ? AND CONVERT(date, a.LoadUpdateDate, 101) = CONVERT(date, GETDATE(), 101)
      AND ({glp1})
    ORDER BY loadcategory, last_name, first_name
    """
    return cur.execute(sql, cfg["carrier"], c["clientid"]).fetchall()


def report_html(cfg, rows):
    groups = {}
    for r in rows:
        groups.setdefault(r.loadcategory, []).append(r)
    parts = [f"<h2>{cfg['group_name']} — Import Reconciliation ({date.today():%m/%d/%Y})</h2>"]
    order = ["Eligibility - Adds", "Eligibility - Terms", "Claims - GLP1 - Adds"]
    for cat in order:
        items = groups.get(cat, [])
        parts.append(f"<h3>{cat} ({len(items)})</h3>")
        if items:
            parts.append("<table border=1 cellpadding=4 cellspacing=0><tr><th>Group</th><th>Last</th><th>First</th><th>Load Date</th></tr>")
            for r in items:
                parts.append(f"<tr><td>{r.grp or ''}</td><td>{r.last_name or ''}</td><td>{r.first_name or ''}</td><td>{r.d or ''}</td></tr>")
            parts.append("</table>")
        else:
            parts.append("<p><i>none</i></p>")
    return "\n".join(parts)


def send_email(cfg, html):
    host = os.environ.get("SMTP_HOST")
    if not host:
        sys.exit("--send requires SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/MAIL_FROM env vars")
    msg = MIMEText(html, "html")
    msg["Subject"] = f"{cfg['group_name']} Import Reconciliation — {date.today():%m/%d/%Y}"
    msg["From"] = os.environ.get("MAIL_FROM", os.environ.get("SMTP_USER"))
    msg["To"] = ", ".join(AMT_RECIPIENTS)
    with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", 587))) as s:
        s.starttls()
        if os.environ.get("SMTP_USER"):
            s.login(os.environ["SMTP_USER"], os.environ["SMTP_PASS"])
        s.sendmail(msg["From"], AMT_RECIPIENTS, msg.as_string())
    print(f"  Emailed report to {', '.join(AMT_RECIPIENTS)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("client")
    ap.add_argument("--commit", action="store_true", help="write to prod (default: dry run)")
    ap.add_argument("--send", action="store_true", help="email the AMT report")
    args = ap.parse_args()

    cfg = RECON.get(args.client)
    if not cfg:
        sys.exit(f"Unknown client '{args.client}'. Known: {', '.join(RECON)}")
    if not os.environ.get("IRX_DB_PWD"):
        sys.exit("Missing env var IRX_DB_PWD")

    cn = db_connect(autocommit=False)
    cur = cn.cursor()
    print(f"== {cfg['group_name']} reconcile ({'COMMIT' if args.commit else 'DRY RUN'}) ==")
    try:
        eligibility_reconcile(cur, cfg, args.commit)
        claims_reconcile(cur, cfg, args.commit)
        if args.commit:
            cn.commit()
            print("  committed.")
        rows = build_report(cur, cfg)
        print(f"  AMT report rows (loaded today): {len(rows)}")
        html = report_html(cfg, rows)
        if args.send:
            send_email(cfg, html)
        else:
            out = os.path.join(os.path.dirname(__file__), f"reconcile_{args.client}_preview.html")
            with open(out, "w", encoding="utf-8") as f:
                f.write(html)
            print(f"  report preview written: {out}")
    except Exception:
        cn.rollback()
        raise
    finally:
        cur.close(); cn.close()


if __name__ == "__main__":
    main()
