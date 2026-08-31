"""Ongoing sync of the Unifeyed masters into iRx + a reconciliation report.

Re-runs every idempotent master loader (products, client pricing/formulary,
members/medications/clients) — each is a MERGE on a stable source key, so this is
safe to run repeatedly (e.g. nightly until full cutover). Afterwards it prints a
reconciliation report comparing Unifeyed source row counts to the iRx targets.

Env: IRX_DB_PWD.  Usage: python scripts/procurement/sync_masters.py [--report-only]
"""
import os
import sys
import subprocess
import pyodbc

HERE = os.path.dirname(os.path.abspath(__file__))
LOADERS = ['import_products.py', 'import_pricing.py', 'import_members.py']

# (label, Unifeyed source count SQL, iRx target count SQL)
CHECKS = [
    ('products',      'SELECT COUNT(*) FROM Unifeyed.dbo.tblproducts',                 'SELECT COUNT(*) FROM dbo.tp_products'),
    ('product NDCs',  'SELECT COUNT(*) FROM Unifeyed.dbo.tblproduct_ndc_codes',        'SELECT COUNT(*) FROM dbo.tp_product_ndc'),
    ('companies',     'SELECT COUNT(*) FROM Unifeyed.dbo.tblcompanies',                'SELECT COUNT(*) FROM dbo.tp_uf_companies'),
    ('client pricing','SELECT COUNT(*) FROM Unifeyed.dbo.tblcompany_pricing',          'SELECT COUNT(*) FROM dbo.tp_client_pricing'),
    ('formularies',   'SELECT COUNT(*) FROM Unifeyed.dbo.tblcompanies_assigned_products','SELECT COUNT(*) FROM dbo.tp_client_formulary'),
    ('members',       'SELECT COUNT(*) FROM Unifeyed.dbo.tblclients',                  'SELECT COUNT(*) FROM dbo.tp_uf_members'),
    ('medications',   'SELECT COUNT(*) FROM Unifeyed.dbo.tblmedications',              'SELECT COUNT(*) FROM dbo.tp_member_medications'),
]


def db():
    return pyodbc.connect(
        'DRIVER={ODBC Driver 17 for SQL Server};SERVER=tcp:74.117.224.152,1433;DATABASE=iRx;'
        'UID=claudeservices;PWD=' + os.environ['IRX_DB_PWD'] +
        ';Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=90')


def run_loaders():
    for f in LOADERS:
        print(f"\n>>> {f}")
        r = subprocess.run([sys.executable, os.path.join(HERE, f)], env=os.environ)
        if r.returncode != 0:
            print(f"!! {f} exited {r.returncode}")


def report():
    cur = db().cursor()
    print("\n=== Reconciliation (Unifeyed source -> iRx target) ===")
    print("  %-16s %10s %10s   %s" % ('master', 'source', 'iRx', 'status'))
    for label, src_sql, tgt_sql in CHECKS:
        try:
            src = cur.execute(src_sql).fetchone()[0]
            tgt = cur.execute(tgt_sql).fetchone()[0]
            # targets can legitimately be <= source (bad keys, dedup); flag only shortfalls > 1%
            ok = tgt >= src or (src and (src - tgt) / src <= 0.01)
            status = 'OK' if ok else f'CHECK (-{src - tgt})'
            print("  %-16s %10s %10s   %s" % (label, f'{src:,}', f'{tgt:,}', status))
        except Exception as e:  # noqa: BLE001
            print("  %-16s  ERROR: %s" % (label, e))


def main():
    if '--report-only' not in sys.argv:
        run_loaders()
    report()


if __name__ == '__main__':
    main()
