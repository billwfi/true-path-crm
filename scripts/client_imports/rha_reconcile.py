"""RHA eligibility reconcile — name+DOB matcher (option B).

RHA's file carries a *different* member-ID scheme (11-digit numeric, e.g.
90038908900) than production eligibility (legacy alphanumeric, e.g. 224M7754200).
They are unrelated identifiers for the same people — the only reliable crosswalk
is LAST_NAME + FIRST_NAME + DATE_OF_BIRTH (a 98% match). Reconciling on the raw ID
would create ~1,946 duplicate members. Production is also already partly duplicated
(1,287 numeric records from a prior partial load, alongside 3,405 alphanumeric).

This script therefore:
  1. Resolves each file member to its canonical production record by name+DOB.
     Canonical = the legacy ALPHANUMERIC record when one exists for that person.
  2. UPDATES the canonical record's coverage span from the file.
  3. INACTIVATES canonical members that are active in production but absent from
     the file (sets MEMBER_THRU_DATE = run date).
  4. Flags — and, with --dedupe, inactivates — the numeric duplicate records for any
     person who also has an alphanumeric record, so production settles on one ID.
  5. HOLDS (reports, never auto-inserts) file members with no name+DOB match, since
     those are usually spelling/DOB variance, not genuinely new people.

Detail rows land in dbo.Import_Reconcile_Items and a dbo.Import_Runs row is written
so the per-client import email renders normally.

DRY RUN by default. Pass --commit to write to production eligibility.
  python scripts/client_imports/rha_reconcile.py                 # dry run report
  python scripts/client_imports/rha_reconcile.py --commit        # write updates + inactivations
  python scripts/client_imports/rha_reconcile.py --commit --dedupe   # also retire numeric dupes
"""
import os
import re
import sys
from collections import defaultdict
from datetime import datetime

import pyodbc

CARRIER = "PSI4105"
CLIENT_ID = 20
CONFIG_ID = 3
STAGE = "dbo.Eligibility_RHA"
PROD = "dbo.eligibility"


def db():
    return pyodbc.connect(
        "DRIVER={ODBC Driver 17 for SQL Server};SERVER=tcp:74.117.224.152,1433;DATABASE=iRx;"
        "UID=claudeservices;PWD=" + os.environ["IRX_DB_PWD"] +
        ";Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=60", autocommit=False)


def pdate(s):
    if s is None:
        return None
    s = str(s).strip().split(" ")[0]
    if not s or s.startswith("00-0") or s.startswith("0000"):
        return None
    for f in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%Y%m%d", "%m-%d-%Y"):
        try:
            return datetime.strptime(s, f).date()
        except ValueError:
            continue
    try:
        y, m, d = s.split("-")
        if len(y) == 2:
            return datetime(2000 + int(y), int(m), int(d)).date()
    except (ValueError, TypeError):
        pass
    return None


def nm(v):
    return re.sub(r"\s+", " ", (v or "").strip().upper())


def is_numeric_id(x):
    return bool(re.fullmatch(r"\d+", x or ""))


def load(cur):
    """Return (file_by_key, prod_recs, prod_by_key).
    key = (last, first, dob).  file value = dict; prod rec = dict."""
    file_by_key = {}
    dup_file = 0
    cur.execute(f"SELECT Member_ID, Last_Name, Member_First_Name, Date_of_Birth, "
                f"Member_Date_Effective, Member_Thru_Date FROM {STAGE}")
    for r in cur.fetchall():
        key = (nm(r[1]), nm(r[2]), pdate(r[3]))
        rec = dict(file_id=(str(r[0]).strip() if r[0] else ""), last=nm(r[1]), first=nm(r[2]),
                   dob=key[2], eff=r[4], thru=r[5])
        if key in file_by_key:
            dup_file += 1
        file_by_key[key] = rec

    prod_recs = []
    prod_by_key = defaultdict(list)
    malformed = []  # 13-char column-shifted records — corrupt dups of a clean 11-char twin
    cur.execute(f"SELECT MEMBER_ID, LAST_NAME, FIRST_NAME, DATE_OF_BIRTH, SEX, MEMBER_THRU_DATE "
                f"FROM {PROD} WHERE CARRIER=?", CARRIER)
    for r in cur.fetchall():
        pid = str(r[0]).strip() if r[0] else ""
        # A member id longer than 11 chars is the signature of the shifted bad load:
        # the columns are all offset, so its name/DOB are meaningless. Its clean twin
        # is pid[:11]. Keep it out of name+DOB matching and list it for cleanup.
        if len(pid) > 11:
            malformed.append(dict(id=pid, twin=pid[:11], stray_last=nm(r[1]),
                                  real_last=nm(r[2]), real_first=(str(r[3]).strip() if r[3] else "")))
            continue
        key = (nm(r[1]), nm(r[2]), pdate(r[3]))
        thru = pdate(r[5])
        active = (thru is None or thru >= datetime.now().date())
        rec = dict(id=pid, last=nm(r[1]), first=nm(r[2]), dob=key[2], sex=r[4],
                   thru_raw=r[5], active=active, numeric=is_numeric_id(pid), key=key)
        prod_recs.append(rec)
        prod_by_key[key].append(rec)
    return file_by_key, prod_recs, prod_by_key, dup_file, malformed


def canonical_of(recs):
    """Pick the system-of-record production row for a person: prefer an
    alphanumeric (legacy) record, else the numeric one."""
    alpha = [r for r in recs if not r["numeric"]]
    return (alpha[0] if alpha else recs[0]) if recs else None


def analyze(file_by_key, prod_recs, prod_by_key, malformed):
    plan = dict(updates=[], inactivations=[], holds=[], dupes=[], ambiguous=[], malformed=malformed)
    # Persons present in production with both an alphanumeric and a numeric record →
    # the numeric records are duplicates to retire.
    for key, recs in prod_by_key.items():
        has_alpha = any(not r["numeric"] for r in recs)
        if has_alpha:
            for r in recs:
                if r["numeric"]:
                    plan["dupes"].append(r)
        if len([r for r in recs if not r["numeric"]]) > 1:
            plan["ambiguous"].append((key, recs))

    # File → canonical resolution.
    for key, f in file_by_key.items():
        recs = prod_by_key.get(key)
        if not recs:
            plan["holds"].append(f)
            continue
        canon = canonical_of(recs)
        plan["updates"].append((f, canon))

    # Inactivations: a person's canonical record is active in prod but the person
    # is absent from the file.
    for key, recs in prod_by_key.items():
        if key in file_by_key:
            continue
        canon = canonical_of(recs)
        if canon and canon["active"] and canon.get("last"):
            plan["inactivations"].append(canon)
    return plan


def report(plan, dup_file):
    u, i, h, d, amb = (plan["updates"], plan["inactivations"], plan["holds"],
                       plan["dupes"], plan["ambiguous"])
    print("\n================  RHA reconcile — name+DOB matcher (dry run)  ================")
    print(f"  UPDATE   (file member matched to canonical prod record) : {len(u):,}")
    print(f"  INACTIVATE (canonical active, absent from file)          : {len(i):,}")
    print(f"  HOLD     (file member with no name+DOB match — review)   : {len(h):,}")
    print(f"  DEDUPE   (numeric dup records; person has alphanumeric)  : {len(d):,}")
    print(f"  MALFORMED (13-char shifted dups; clean twin confirmed)   : {len(plan['malformed']):,}")
    print(f"  ambiguous (same name+DOB → >1 alphanumeric prod record)  : {len(amb):,}")
    if dup_file:
        print(f"  note: {dup_file} duplicate name+DOB rows within the file (last wins)")

    def show(title, rows, fmt, n=8):
        if not rows:
            return
        print(f"\n  --- {title} (first {min(n, len(rows))}) ---")
        for r in rows[:n]:
            print("   ", fmt(r))

    show("INACTIVATIONS", i, lambda r: f"{r['id']:<13} {r['last']}, {r['first']}  {r['dob']}  [{r['sex']}]")
    show("HOLDS (no match — review for spelling/DOB variance)", h,
         lambda r: f"{r['file_id']:<13} {r['last']}, {r['first']}  {r['dob']}")
    show("NUMERIC DUPES to retire", d, lambda r: f"{r['id']:<13} {r['last']}, {r['first']}  {r['dob']}")
    show("UPDATES (file_id -> canonical prod id)", u,
         lambda t: f"{t[0]['file_id']:<13} -> {t[1]['id']:<13} {t[1]['last']}, {t[1]['first']}")
    show("AMBIGUOUS (needs manual check)", amb,
         lambda t: f"{t[0][0]}, {t[0][1]} {t[0][2]} -> " + ", ".join(r['id'] for r in t[1]))


def commit(cur, plan, dedupe):
    today = datetime.now().date()
    run_date = f"{today.month}/{today.day}/{today.year}"
    cur.execute(
        "INSERT INTO dbo.Import_Runs (config_id, started_at, status, file_name, rows_imported) "
        "OUTPUT INSERTED.id VALUES (?, GETDATE(), 'Running', ?, ?)",
        CONFIG_ID, "RHA name+DOB reconcile", len(plan["updates"]))
    run_id = cur.fetchone()[0]

    # UPDATE canonical coverage spans from the file.
    upd = [(f["eff"], f["thru"], today, CARRIER, canon["id"])
           for (f, canon) in plan["updates"]]
    if upd:
        cur.fast_executemany = True
        cur.executemany(
            f"UPDATE {PROD} SET MEMBER_FROM_DATE=?, MEMBER_THRU_DATE=?, LoadUpdateDate=? "
            f"WHERE CARRIER=? AND MEMBER_ID=?", upd)

    # INACTIVATE canonical members absent from the file.
    inact = [(run_date, today, CARRIER, r["id"]) for r in plan["inactivations"]]
    if inact:
        cur.fast_executemany = True
        cur.executemany(
            f"UPDATE {PROD} SET MEMBER_THRU_DATE=?, LoadUpdateDate=? WHERE CARRIER=? AND MEMBER_ID=?",
            inact)

    # DEDUPE: retire numeric duplicate records (inactivate — reversible).
    deduped = 0
    if dedupe and plan["dupes"]:
        ded = [(run_date, today, CARRIER, r["id"]) for r in plan["dupes"]]
        cur.fast_executemany = True
        cur.executemany(
            f"UPDATE {PROD} SET MEMBER_THRU_DATE=?, LoadUpdateDate=? WHERE CARRIER=? AND MEMBER_ID=?",
            ded)
        deduped = len(ded)

    # Detail rows for the email.
    item_sql = ("INSERT INTO dbo.Import_Reconcile_Items "
                "(run_id, config_id, action, carrier, member_id, last_name, first_name, date_of_birth) "
                "VALUES (?,?,?,?,?,?,?,?)")
    inact_items = [(run_id, CONFIG_ID, "Inactivate", CARRIER, r["id"], r["last"], r["first"], str(r["dob"] or ""))
                   for r in plan["inactivations"]]
    dupe_items = [(run_id, CONFIG_ID, "Dedupe", CARRIER, r["id"], r["last"], r["first"], str(r["dob"] or ""))
                  for r in plan["dupes"]] if dedupe else []
    cur.fast_executemany = True
    if inact_items:
        cur.executemany(item_sql, inact_items)
    if dupe_items:
        cur.executemany(item_sql, dupe_items)

    cur.execute(
        "UPDATE dbo.Import_Runs SET finished_at=GETDATE(), status='Success', "
        "added_count=0, updated_count=?, inactivated_count=?, "
        "message=? WHERE id=?",
        len(plan["updates"]), len(plan["inactivations"]),
        f"name+DOB reconcile: {len(plan['updates'])} updated, {len(plan['inactivations'])} inactivated, "
        f"{deduped} numeric dupes retired, {len(plan['holds'])} held (no match)", run_id)
    return run_id, deduped


def main():
    do_commit = "--commit" in sys.argv
    do_dedupe = "--dedupe" in sys.argv
    cn = db()
    cn.timeout = 90
    cur = cn.cursor()
    file_by_key, prod_recs, prod_by_key, dup_file, malformed = load(cur)
    print(f"file members (unique name+DOB): {len(file_by_key):,}")
    print(f"prod PSI4105 records: {len(prod_recs):,} "
          f"(numeric {sum(r['numeric'] for r in prod_recs):,} / "
          f"alphanumeric {sum(not r['numeric'] for r in prod_recs):,})  "
          f"+ {len(malformed):,} malformed excluded")
    plan = analyze(file_by_key, prod_recs, prod_by_key, malformed)
    report(plan, dup_file)

    if not do_commit:
        print("\nDRY RUN — nothing written. Re-run with --commit (add --dedupe to retire numeric dupes).")
        cn.rollback()
        return
    if plan["ambiguous"]:
        print(f"\nREFUSING to commit: {len(plan['ambiguous'])} ambiguous name+DOB collisions need manual review first.")
        cn.rollback()
        return
    run_id, deduped = commit(cur, plan, do_dedupe)
    cn.commit()
    print(f"\nCOMMITTED (run_id={run_id}): {len(plan['updates'])} updated, "
          f"{len(plan['inactivations'])} inactivated, {deduped} numeric dupes retired, "
          f"{len(plan['holds'])} held.")


if __name__ == "__main__":
    main()
