"""Migrate clients (companies), member profiles, and medication history from Unifeyed.

  tp_clients.uf_company_id  <- link each Unifeyed company to a tp_clients row
                              (dedup by name; insert the company as a client if new)
  tp_uf_members             <- tblclients (6,569 member/patient profiles)
  tp_member_medications     <- tblmedications (10,157 Rx/med history)

Env: IRX_DB_PWD.  Usage: python scripts/procurement/import_members.py
"""
import os
import re
import pyodbc

DDL = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                   'netlify', 'database', 'sqlserver', '047_members.sql')


def db(name='iRx'):
    return pyodbc.connect(
        'DRIVER={ODBC Driver 17 for SQL Server};SERVER=tcp:74.117.224.152,1433;DATABASE=' + name + ';'
        'UID=claudeservices;PWD=' + os.environ['IRX_DB_PWD'] +
        ';Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=90', autocommit=True)


MERGE_MEMBERS = """
MERGE dbo.tp_uf_members AS tgt
USING (SELECT userid member_source_id, TRY_CONVERT(int,company_id) uf_company_id,
              LEFT(first_name,100) first_name, LEFT(last_name,100) last_name, LEFT(gender,20) gender,
              LEFT(date_of_birth,40) date_of_birth, LEFT(CAST(member_id AS nvarchar(50)),50) member_id,
              LEFT(cardholder_id,50) cardholder_id, LEFT(group_id,50) group_id, LEFT(person_code,10) person_code,
              LEFT(relationship_code,20) relationship_code,
              LEFT(COALESCE(NULLIF(client_email,''),email_address),150) email,
              LEFT(COALESCE(NULLIF(primary_phone,''),phonenumber),50) phone,
              LEFT(address,200) address, LEFT(city,100) city, LEFT(state,50) state, LEFT(zip,20) zip,
              LEFT(enrollment_status,60) enrollment_status, LEFT(eligible_thru,40) eligible_thru,
              CASE WHEN active=1 THEN 1 ELSE 0 END active
       FROM Unifeyed.dbo.tblclients) src
ON tgt.member_source_id = src.member_source_id
WHEN MATCHED THEN UPDATE SET uf_company_id=src.uf_company_id, first_name=src.first_name, last_name=src.last_name,
     gender=src.gender, date_of_birth=src.date_of_birth, member_id=src.member_id, cardholder_id=src.cardholder_id,
     group_id=src.group_id, person_code=src.person_code, relationship_code=src.relationship_code, email=src.email,
     phone=src.phone, address=src.address, city=src.city, state=src.state, zip=src.zip,
     enrollment_status=src.enrollment_status, eligible_thru=src.eligible_thru, active=src.active
WHEN NOT MATCHED THEN INSERT (member_source_id,uf_company_id,first_name,last_name,gender,date_of_birth,member_id,
     cardholder_id,group_id,person_code,relationship_code,email,phone,address,city,state,zip,enrollment_status,eligible_thru,active)
   VALUES (src.member_source_id,src.uf_company_id,src.first_name,src.last_name,src.gender,src.date_of_birth,src.member_id,
     src.cardholder_id,src.group_id,src.person_code,src.relationship_code,src.email,src.phone,src.address,src.city,src.state,
     src.zip,src.enrollment_status,src.eligible_thru,src.active);
"""

MERGE_MEDS = """
MERGE dbo.tp_member_medications AS tgt
USING (SELECT id source_id, TRY_CONVERT(bigint,customer_id) member_source_id, TRY_CONVERT(int,drug) product_source_id,
              LEFT(strength,100) strength, LEFT(day_supply,40) day_supply, LEFT(number_of_refills,20) number_of_refills,
              LEFT(next_fill_order_date,40) next_fill_order_date, LEFT(ndc_code,40) ndc_code,
              LEFT(reporting_unit,60) reporting_unit, TRY_CONVERT(decimal(18,4),reporting_qty) reporting_qty,
              CASE WHEN inactive=1 THEN 1 ELSE 0 END inactive
       FROM Unifeyed.dbo.tblmedications) src
ON tgt.source_id = src.source_id
WHEN MATCHED THEN UPDATE SET member_source_id=src.member_source_id, product_source_id=src.product_source_id,
     strength=src.strength, day_supply=src.day_supply, number_of_refills=src.number_of_refills,
     next_fill_order_date=src.next_fill_order_date, ndc_code=src.ndc_code, reporting_unit=src.reporting_unit,
     reporting_qty=src.reporting_qty, inactive=src.inactive
WHEN NOT MATCHED THEN INSERT (source_id,member_source_id,product_source_id,strength,day_supply,number_of_refills,
     next_fill_order_date,ndc_code,reporting_unit,reporting_qty,inactive)
   VALUES (src.source_id,src.member_source_id,src.product_source_id,src.strength,src.day_supply,src.number_of_refills,
     src.next_fill_order_date,src.ndc_code,src.reporting_unit,src.reporting_qty,src.inactive);
"""


def main():
    cn = db(); cur = cn.cursor()
    for batch in re.split(r'(?im)^\s*GO\s*$', open(DDL, encoding='utf-8').read()):
        if batch.strip():
            cur.execute(batch)

    # 1) clients: migrate Unifeyed companies into tp_clients (dedup by name, link uf_company_id)
    src = db('Unifeyed').cursor()
    comps = src.execute("""SELECT id, LEFT(name,200) name, LEFT(email,150) email,
        LEFT(COALESCE(NULLIF(phone,''),mc_phone),50) phone, LEFT(address,200) address,
        LEFT(city,100) city, LEFT(state,50) state, LEFT(zipcode,20) zip,
        LEFT(eligibility_file_name,200) elig, LEFT(CAST(status AS nvarchar(50)),50) status
        FROM dbo.tblcompanies WHERE NULLIF(LTRIM(RTRIM(name)),'') IS NOT NULL""").fetchall()
    linked = inserted = 0
    for c in comps:
        cid = c[0]
        ex = cur.execute("SELECT id, uf_company_id FROM dbo.tp_clients WHERE LOWER(name)=LOWER(?)", c[1]).fetchone()
        if ex:
            if ex[1] is None:
                cur.execute("UPDATE dbo.tp_clients SET uf_company_id=? WHERE id=?", cid, ex[0]); linked += 1
        else:
            cur.execute("""INSERT INTO dbo.tp_clients (name,email,phone,address,city,state,zip_code,active,notes,uf_company_id)
                           VALUES (?,?,?,?,?,?,?,?,?,?)""",
                        c[1], c[2] or None, c[3] or None, c[4] or None, c[5] or None, c[6] or None, c[7] or None,
                        1, (('Migrated from Unifeyed. ' + (c[8] or '')).strip())[:500], cid)
            inserted += 1
    print(f"clients: {inserted} inserted, {linked} linked (existing) — {len(comps)} Unifeyed companies")

    # 2) members
    cur.execute(MERGE_MEMBERS)
    mem = cur.execute("SELECT COUNT(*) FROM dbo.tp_uf_members").fetchone()[0]
    # 3) medications
    cur.execute(MERGE_MEDS)
    med = cur.execute("SELECT COUNT(*) FROM dbo.tp_member_medications").fetchone()[0]
    medlinked = cur.execute("SELECT COUNT(*) FROM dbo.tp_member_medications m JOIN dbo.tp_products p ON p.source_id=m.product_source_id").fetchone()[0]
    print(f"tp_uf_members: {mem} | tp_member_medications: {med} (linked to product master: {medlinked})")


if __name__ == '__main__':
    main()
