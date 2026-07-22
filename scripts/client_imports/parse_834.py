"""Parse an X12 EDI 834 (Benefit Enrollment) file into a per-client eligibility
staging table, so reconcile.py can load it into dbo.eligibility.

This is the 834 counterpart to sftp_import.py (which handles CSV/XLSX rosters).
It decodes the member (INS) loops of an 834 and writes one row per member to
dbo.<stage_table>. DROP + CREATE + load each run.

834 segments consumed per member loop:
  INS  01=subscriber Y/N  02=relationship  03=maint-type  08=employment-status
  REF*0F  subscriber id (-> MEMBER_ID)        REF*1L  group/policy no.
  NM1*IL  03=last 04=first 05=middle  08/09=SSN qualifier/value
  EM      email            HP      phone
  N3      address1 [address2]        N4  city / state / zip
  DMG*D8  02=DOB(CCYYMMDD) 03=gender(M/F/U)
  HD      05=coverage level (EMP/ESP/ECH/FAM)
  DTP*348 coverage begin (min kept)  DTP*349 coverage end (if present)

Usage:
  python scripts/client_imports/parse_834.py anders <file>            # load staging
  python scripts/client_imports/parse_834.py anders <file> --preview  # parse only, no DB

Env: IRX_DB_PWD (required unless --preview).
"""
import argparse
import os
import sys
import pyodbc

# ── Per-client 834 config ────────────────────────────────────────────────────
CLIENTS834 = {
    "anders": {
        "carrier": "000239911",
        "group_name": "Anders Group",
        "stage_table": "Eligibility834_Anders",
    },
}

# Staging columns (name, sqltype). All text — reconcile maps/casts downstream.
STAGE_COLS = [
    ("Carrier", "NVARCHAR(12)"),
    ("Member_Id", "NVARCHAR(30)"),          # REF*0F subscriber id
    ("Person_Ssn", "NVARCHAR(30)"),         # NM1*IL member's own SSN
    ("Subscriber_Flag", "NVARCHAR(1)"),     # INS01 Y/N
    ("Relationship", "NVARCHAR(2)"),        # INS02
    ("Maint_Type", "NVARCHAR(3)"),          # INS03
    ("Employment_Status", "NVARCHAR(2)"),   # INS08
    ("Last_Name", "NVARCHAR(60)"),
    ("First_Name", "NVARCHAR(60)"),
    ("Middle_Name", "NVARCHAR(60)"),
    ("Gender", "NVARCHAR(1)"),
    ("Date_Of_Birth", "NVARCHAR(10)"),      # ISO yyyy-mm-dd
    ("Address1", "NVARCHAR(100)"),
    ("Address2", "NVARCHAR(100)"),
    ("City", "NVARCHAR(60)"),
    ("State", "NVARCHAR(4)"),
    ("Zip", "NVARCHAR(12)"),
    ("Email", "NVARCHAR(120)"),
    ("Phone", "NVARCHAR(20)"),
    ("Coverage_Level", "NVARCHAR(6)"),      # HD05
    ("Member_From_Date", "NVARCHAR(10)"),   # min DTP*348
    ("Member_Thru_Date", "NVARCHAR(10)"),   # DTP*349 if present
    ("Group_Name", "NVARCHAR(60)"),
]
FIELDS = [c for c, _ in STAGE_COLS]


def db_connect():
    conn = (
        "DRIVER={ODBC Driver 17 for SQL Server};"
        f"SERVER={os.environ.get('SQLSERVER_HOST', '74.117.224.152')};"
        f"DATABASE={os.environ.get('SQLSERVER_DB', 'irx')};"
        f"UID={os.environ.get('SQLSERVER_USER', 'claudeservices')};"
        "PWD=" + os.environ["IRX_DB_PWD"] + ";"
        "Encrypt=yes;TrustServerCertificate=yes;"
    )
    return pyodbc.connect(conn, autocommit=False)


def d8(v):
    """CCYYMMDD -> yyyy-mm-dd (or '' if not 8 digits)."""
    v = (v or "").strip()
    return f"{v[0:4]}-{v[4:6]}-{v[6:8]}" if len(v) == 8 and v.isdigit() else ""


def g(seg, i):
    return seg[i].strip() if len(seg) > i and seg[i] is not None else ""


def parse_834(path, cfg):
    raw = open(path, encoding="utf-8-sig").read()
    segs = [s.split("*") for s in raw.replace("\n", "").split("~") if s.strip()]

    # Locate member (INS) loop boundaries.
    ins_idx = [i for i, s in enumerate(segs) if s[0] == "INS"]
    members = []
    for start, end in zip(ins_idx, ins_idx[1:] + [len(segs)]):
        loop = segs[start:end]
        m = {f: "" for f in FIELDS}
        m["Carrier"] = cfg["carrier"]
        m["Group_Name"] = cfg["group_name"]
        froms, thrus = [], []
        for s in loop:
            t = s[0]
            if t == "INS":
                m["Subscriber_Flag"] = g(s, 1)
                m["Relationship"] = g(s, 2)
                m["Maint_Type"] = g(s, 3)
                m["Employment_Status"] = g(s, 8)
            elif t == "REF" and g(s, 1) == "0F":
                m["Member_Id"] = g(s, 2)
            elif t == "NM1" and g(s, 1) == "IL":
                m["Last_Name"], m["First_Name"], m["Middle_Name"] = g(s, 3), g(s, 4), g(s, 5)
                if g(s, 8) == "34":
                    m["Person_Ssn"] = g(s, 9)
            elif t == "EM":
                m["Email"] = g(s, 1)
            elif t == "HP":
                m["Phone"] = g(s, 1)
            elif t == "N3":
                m["Address1"], m["Address2"] = g(s, 1), g(s, 2)
            elif t == "N4":
                m["City"], m["State"], m["Zip"] = g(s, 1), g(s, 2), g(s, 3)
            elif t == "DMG" and g(s, 1) == "D8":
                m["Date_Of_Birth"], m["Gender"] = d8(g(s, 2)), g(s, 3)
            elif t == "HD":
                lvl = g(s, 5)
                if lvl and not m["Coverage_Level"]:
                    m["Coverage_Level"] = lvl
            elif t == "DTP":
                q, dt = g(s, 1), d8(g(s, 3))
                if not dt:
                    continue
                if q == "348":
                    froms.append(dt)
                elif q == "349":
                    thrus.append(dt)
        m["Member_From_Date"] = min(froms) if froms else ""
        m["Member_Thru_Date"] = max(thrus) if thrus else ""
        if m["Member_Id"]:
            members.append(m)
    return members


def load_staging(cur, table, members):
    cols_ddl = ", ".join(f"[{c}] {t}" for c, t in STAGE_COLS)
    cur.execute(f"IF OBJECT_ID('dbo.[{table}]','U') IS NOT NULL DROP TABLE dbo.[{table}]")
    cur.execute(f"CREATE TABLE dbo.[{table}] ({cols_ddl})")
    collist = ", ".join(f"[{c}]" for c in FIELDS)
    ph = ", ".join("?" for _ in FIELDS)
    cur.fast_executemany = True
    cur.executemany(
        f"INSERT INTO dbo.[{table}] ({collist}) VALUES ({ph})",
        [tuple((m[f] or None) for f in FIELDS) for m in members],
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("client")
    ap.add_argument("file")
    ap.add_argument("--preview", action="store_true", help="parse only, no DB write")
    args = ap.parse_args()

    cfg = CLIENTS834.get(args.client)
    if not cfg:
        sys.exit(f"Unknown client '{args.client}'. Known: {', '.join(CLIENTS834)}")
    if not os.path.exists(args.file):
        sys.exit(f"File not found: {args.file}")

    members = parse_834(args.file, cfg)
    subs = sum(1 for m in members if m["Subscriber_Flag"] == "Y")
    terms = sum(1 for m in members if m["Member_Thru_Date"])
    print(f"== {cfg['group_name']} 834 parse ==")
    print(f"  {len(members)} members ({subs} subscribers, {len(members)-subs} dependents), "
          f"{terms} with an end date")
    print("  sample:")
    for m in members[:3]:
        print(f"    {m['Member_Id']}  {m['Last_Name']}, {m['First_Name']}  "
              f"DOB {m['Date_Of_Birth']} {m['Gender']}  rel {m['Relationship']}  "
              f"from {m['Member_From_Date']}  cov {m['Coverage_Level']}")

    if args.preview:
        print("\n  --preview: nothing written.")
        return
    if not os.environ.get("IRX_DB_PWD"):
        sys.exit("Missing env var IRX_DB_PWD (or use --preview)")

    cn = db_connect(); cur = cn.cursor()
    try:
        load_staging(cur, cfg["stage_table"], members)
        cn.commit()
        print(f"\n  loaded {len(members)} rows -> dbo.{cfg['stage_table']}")
    except Exception:
        cn.rollback(); raise
    finally:
        cur.close(); cn.close()


if __name__ == "__main__":
    main()
