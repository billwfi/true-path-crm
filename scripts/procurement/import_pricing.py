"""Migrate client pricing / rebates / formulary from Unifeyed into iRx.

  tp_uf_companies      <- tblcompanies (cross-DB MERGE)
  tp_client_pricing    <- tblcompany_pricing (cross-DB MERGE; parses $-strings)
  tp_client_formulary  <- tblcompanies_assigned_products (JSON stored per company;
                          not exploded — the arrays hold thousands of ids and this
                          server is slow, so we keep the JSON + a parsed count)

Env: IRX_DB_PWD.  Usage: python scripts/procurement/import_pricing.py
"""
import os
import re
import json
import pyodbc

DDL = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                   'netlify', 'database', 'sqlserver', '046_client_pricing.sql')


def db(dbname='iRx'):
    return pyodbc.connect(
        'DRIVER={ODBC Driver 17 for SQL Server};SERVER=tcp:74.117.224.152,1433;DATABASE=' + dbname + ';'
        'UID=claudeservices;PWD=' + os.environ['IRX_DB_PWD'] +
        ';Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=60', autocommit=True)


def money(col):
    return (f"TRY_CONVERT(decimal(18,2), NULLIF(REPLACE(REPLACE(REPLACE("
            f"CAST({col} AS nvarchar(60)),'$',''),',',''),' ',''),''))")


MERGE_COMPANIES = """
MERGE dbo.tp_uf_companies AS tgt
USING (SELECT id company_id, LEFT(name,200) name, LEFT(eligibility_file_name,200) elig,
              LEFT(CAST(status AS nvarchar(50)),50) status, LEFT(CAST(broker AS nvarchar(100)),100) broker,
              LEFT(CAST(awpdiscount AS nvarchar(50)),50) awp, LEFT(city,100) city, LEFT(state,50) state
       FROM Unifeyed.dbo.tblcompanies) src
ON tgt.company_id = src.company_id
WHEN MATCHED THEN UPDATE SET name=src.name, eligibility_file_name=src.elig, status=src.status,
     broker=src.broker, awp_discount=src.awp, city=src.city, state=src.state
WHEN NOT MATCHED THEN INSERT (company_id,name,eligibility_file_name,status,broker,awp_discount,city,state)
     VALUES (src.company_id,src.name,src.elig,src.status,src.broker,src.awp,src.city,src.state);
"""

MERGE_PRICING = f"""
MERGE dbo.tp_client_pricing AS tgt
USING (SELECT p.id source_id, TRY_CONVERT(int,p.company_id) company_id, TRY_CONVERT(int,p.drug) product_source_id,
              {money('p.price')} price, TRY_CONVERT(decimal(18,4),p.company_specific_unit_price) company_unit_price,
              {money('p.rebate_amount')} rebate_amount, {money('p.max_annual_rebate')} max_annual_rebate,
              LEFT(p.ndc_codes,100) ndc_codes
       FROM Unifeyed.dbo.tblcompany_pricing p) src
ON tgt.source_id = src.source_id
WHEN MATCHED THEN UPDATE SET company_id=src.company_id, product_source_id=src.product_source_id, price=src.price,
     company_unit_price=src.company_unit_price, rebate_amount=src.rebate_amount,
     max_annual_rebate=src.max_annual_rebate, ndc_codes=src.ndc_codes
WHEN NOT MATCHED THEN INSERT (source_id,company_id,product_source_id,price,company_unit_price,rebate_amount,max_annual_rebate,ndc_codes)
     VALUES (src.source_id,src.company_id,src.product_source_id,src.price,src.company_unit_price,src.rebate_amount,src.max_annual_rebate,src.ndc_codes);
"""


def main():
    cn = db(); cur = cn.cursor()
    for batch in re.split(r'(?im)^\s*GO\s*$', open(DDL, encoding='utf-8').read()):
        if batch.strip():
            cur.execute(batch)
    cur.execute(MERGE_COMPANIES)
    cur.execute(MERGE_PRICING)
    comp = cur.execute("SELECT COUNT(*) FROM dbo.tp_uf_companies").fetchone()[0]
    pr = cur.execute("SELECT COUNT(*) FROM dbo.tp_client_pricing").fetchone()[0]
    prr = cur.execute("SELECT COUNT(*) FROM dbo.tp_client_pricing WHERE rebate_amount>0").fetchone()[0]

    # formulary — store JSON per company (parse count in Python)
    src = db('Unifeyed').cursor()
    rows = src.execute("SELECT company_id, products FROM dbo.tblcompanies_assigned_products").fetchall()
    cur.execute("TRUNCATE TABLE dbo.tp_client_formulary")
    n = 0; lens = []
    for cid, prods in rows:
        try:
            arr = [str(x).strip() for x in json.loads(prods)] if prods else []
            arr = [x for x in arr if x]
        except Exception:
            arr = []
        cnt = len(arr); lens.append(cnt)
        cur.execute("IF NOT EXISTS (SELECT 1 FROM dbo.tp_client_formulary WHERE company_id=?) "
                    "INSERT INTO dbo.tp_client_formulary (company_id, products_json, product_count) VALUES (?,?,?)",
                    cid, cid, json.dumps(arr), cnt)
        n += 1
    avg = int(sum(lens) / len(lens)) if lens else 0
    print(f"tp_uf_companies: {comp} | tp_client_pricing: {pr} (rebate>0: {prr}) | tp_client_formulary: {n} "
          f"(avg {avg} products/company, max {max(lens) if lens else 0})")


if __name__ == '__main__':
    main()
