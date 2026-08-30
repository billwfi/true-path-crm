"""Migrate the product master from Unifeyed into iRx (idempotent cross-DB MERGE).

Creates/loads dbo.tp_products (drug catalog with NDC / UOM / pricing / vendor),
dbo.tp_product_ndc (multi-NDC per product), and seeds dbo.tp_vendors from the
distinct vendor ids on Unifeyed.dbo.tblproducts (UBA / Monarch detected from the
uba_id / monarch_id columns). Money fields on tblproducts are '$'-formatted strings,
parsed here. MERGE on source_id keeps ids stable across re-runs.

Env: IRX_DB_PWD.  Usage: python scripts/procurement/import_products.py
"""
import os
import re
import pyodbc

DDL = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                   'netlify', 'database', 'sqlserver', '045_product_master.sql')


def db():
    return pyodbc.connect(
        'DRIVER={ODBC Driver 17 for SQL Server};SERVER=tcp:74.117.224.152,1433;DATABASE=iRx;'
        'UID=claudeservices;PWD=' + os.environ['IRX_DB_PWD'] +
        ';Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=60', autocommit=True)


# '$'-string -> decimal
def money(col):
    return (f"TRY_CONVERT(decimal(18,4), NULLIF(REPLACE(REPLACE(REPLACE("
            f"CAST({col} AS nvarchar(60)),'$',''),',',''),' ',''),''))")


MERGE_PRODUCTS = f"""
MERGE dbo.tp_products AS tgt
USING (
  SELECT p.id AS source_id, LEFT(p.label,300) label, LEFT(p.short_name,150) short_name,
         LEFT(p.strength,100) strength, LEFT(p.ndc,20) ndc, LEFT(p.NDC_Comp,20) ndc_comp,
         LEFT(p.unit_type,60) unit_type, TRY_CONVERT(decimal(18,4), p.unit_quantity) unit_quantity,
         {money('p.unit_price')} unit_price, {money('p.unit_cost')} unit_cost,
         TRY_CONVERT(decimal(18,2), p.price) price, {money('p.cost')}/1.0 cost_raw,
         {money('p.awp')} awp,
         TRY_CONVERT(int, p.vendor) vendor_id, LEFT(CAST(p.class AS nvarchar(60)),60) drug_class,
         CASE WHEN p.specialty_medication=1 THEN 1 ELSE 0 END specialty,
         CASE WHEN p.high_maintenance_medication=1 THEN 1 ELSE 0 END high_maintenance,
         LEFT(p.country,60) country, TRY_CONVERT(int, p.status) source_status,
         TRY_CONVERT(bigint, p.uba_id) uba_id, TRY_CONVERT(bigint, p.monarch_id) monarch_id
  FROM Unifeyed.dbo.tblproducts p
) src ON tgt.source_id = src.source_id
WHEN MATCHED THEN UPDATE SET
   label=src.label, short_name=src.short_name, strength=src.strength, ndc=src.ndc, ndc_comp=src.ndc_comp,
   unit_type=src.unit_type, unit_quantity=src.unit_quantity, unit_price=src.unit_price, unit_cost=src.unit_cost,
   price=src.price, cost=TRY_CONVERT(decimal(18,2),src.cost_raw), awp=src.awp, vendor_id=src.vendor_id,
   drug_class=src.drug_class, specialty=src.specialty, high_maintenance=src.high_maintenance,
   country=src.country, source_status=src.source_status, uba_id=src.uba_id, monarch_id=src.monarch_id,
   updated_at=SYSUTCDATETIME()
WHEN NOT MATCHED THEN INSERT
   (source_id,label,short_name,strength,ndc,ndc_comp,unit_type,unit_quantity,unit_price,unit_cost,
    price,cost,awp,vendor_id,drug_class,specialty,high_maintenance,country,source_status,active,uba_id,monarch_id)
  VALUES
   (src.source_id,src.label,src.short_name,src.strength,src.ndc,src.ndc_comp,src.unit_type,src.unit_quantity,
    src.unit_price,src.unit_cost,src.price,TRY_CONVERT(decimal(18,2),src.cost_raw),src.awp,src.vendor_id,
    src.drug_class,src.specialty,src.high_maintenance,src.country,src.source_status,1,src.uba_id,src.monarch_id);
"""


def main():
    cur = db().cursor()
    # 1) DDL
    sql = open(DDL, encoding='utf-8').read()
    for batch in re.split(r'(?im)^\s*GO\s*$', sql):
        if batch.strip():
            cur.execute(batch)

    # 2) seed vendors (detect UBA / Monarch by which id column dominates each vendor)
    rows = cur.execute("""SELECT TRY_CONVERT(int,vendor) v,
                 SUM(CASE WHEN TRY_CONVERT(bigint,uba_id)>0 THEN 1 ELSE 0 END) uba,
                 SUM(CASE WHEN TRY_CONVERT(bigint,monarch_id)>0 THEN 1 ELSE 0 END) mon, COUNT(*) n
          FROM Unifeyed.dbo.tblproducts WHERE TRY_CONVERT(int,vendor) IS NOT NULL
          GROUP BY TRY_CONVERT(int,vendor)""").fetchall()
    for v, uba, mon, n in rows:
        if v is None:
            continue
        name = 'UBA' if uba > mon and uba > 0 else ('Monarch' if mon > 0 else f'Vendor {v}')
        cur.execute("""IF EXISTS (SELECT 1 FROM dbo.tp_vendors WHERE id=?)
                         UPDATE dbo.tp_vendors SET name=? WHERE id=?
                       ELSE INSERT INTO dbo.tp_vendors (id,name,active) VALUES (?,?,1)""",
                    v, name, v, v, name)
        print(f"  vendor {v}: {name} ({n} products; uba={uba} mon={mon})")

    # 3) products
    before = cur.execute("SELECT COUNT(*) FROM dbo.tp_products").fetchone()[0]
    cur.execute(MERGE_PRODUCTS)
    after = cur.execute("SELECT COUNT(*) FROM dbo.tp_products").fetchone()[0]

    # 4) NDC codes (full refresh — reference child table)
    cur.execute("TRUNCATE TABLE dbo.tp_product_ndc")
    cur.execute("""INSERT INTO dbo.tp_product_ndc (product_source_id, ndc_code)
                   SELECT TRY_CONVERT(int,product_id), LEFT(ndc_codes,40)
                   FROM Unifeyed.dbo.tblproduct_ndc_codes WHERE NULLIF(LTRIM(RTRIM(ndc_codes)),'') IS NOT NULL""")
    ndc = cur.execute("SELECT COUNT(*) FROM dbo.tp_product_ndc").fetchone()[0]

    withndc = cur.execute("SELECT COUNT(*) FROM dbo.tp_products WHERE NULLIF(ndc,'') IS NOT NULL").fetchone()[0]
    print(f"tp_products: {before} -> {after} ({after-before:+d}) | with NDC: {withndc} | tp_product_ndc: {ndc}")


if __name__ == '__main__':
    main()
