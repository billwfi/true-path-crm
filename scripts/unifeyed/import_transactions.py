"""Pull transactions from the Unifeyed database into iRx.dbo.tp_uf_transactions (test data).

Unifeyed and iRx live on the same SQL Server, so this is a single cross-database
MERGE. Each Unifeyed tbltransactions row is joined to its patient (tblclients.userid)
to pick up the group/cardholder identifiers, the group is normalized (COM<id> -> <id>)
so it ties to our eligibility GroupID, and matches_eligibility flags whether that
normalized group exists in dbo.Eligibility_Liviniti.

MERGE on source_id keeps ids stable across re-runs, so payments logged in
tp_uf_transaction_payments survive a reload.

Env: IRX_DB_PWD
Usage: python scripts/unifeyed/import_transactions.py
"""
import os
import pyodbc

SERVER = "tcp:74.117.224.152,1433"


def db():
    return pyodbc.connect(
        f"DRIVER={{ODBC Driver 17 for SQL Server}};SERVER={SERVER};DATABASE=iRx;"
        f"UID=claudeservices;PWD={os.environ['IRX_DB_PWD']};"
        "Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=60",
        autocommit=True)


MERGE_SQL = r"""
MERGE dbo.tp_uf_transactions AS tgt
USING (
  SELECT t.id AS source_id, t.transaction_number, t.order_number, t.customer_id,
         c.first_name AS patient_first, c.last_name AS patient_last,
         c.cardholder_id, c.member_id, c.person_code,
         c.group_id AS raw_group_id,
         CASE WHEN UPPER(LEFT(LTRIM(RTRIM(c.group_id)),3)) = 'COM'
              THEN NULLIF(LTRIM(RTRIM(SUBSTRING(LTRIM(RTRIM(c.group_id)),4,50))),'')
              ELSE NULLIF(LTRIM(RTRIM(c.group_id)),'') END AS group_id,
         t.drug, t.strength, TRY_CONVERT(decimal(18,4), t.reporting_qty) AS reporting_qty,
         t.reporting_unit, t.unit_price,
         TRY_CONVERT(decimal(18,2), t.amount) AS amount,
         TRY_CONVERT(decimal(18,2), t.total_cost) AS total_cost,
         TRY_CONVERT(decimal(18,2), t.client_paid) AS client_paid,
         TRY_CONVERT(decimal(18,2), t.irx_paid) AS irx_paid,
         TRY_CONVERT(decimal(18,2), t.vendor_paid) AS vendor_paid,
         t.status, t.order_status, t.is_paid, t.date_ordered, t.shipped_date, t.delivery_date
  FROM Unifeyed.dbo.tbltransactions t
  JOIN Unifeyed.dbo.tblclients c ON c.userid = t.customer_id
) AS src
ON tgt.source_id = src.source_id
WHEN MATCHED THEN UPDATE SET
    transaction_number = src.transaction_number, order_number = src.order_number,
    customer_id = src.customer_id, patient_first = src.patient_first, patient_last = src.patient_last,
    cardholder_id = src.cardholder_id, member_id = src.member_id, person_code = src.person_code,
    raw_group_id = src.raw_group_id, group_id = src.group_id,
    matches_eligibility = CASE WHEN src.group_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM dbo.Eligibility_Liviniti e WHERE e.GroupID = src.group_id) THEN 1 ELSE 0 END,
    drug = src.drug, strength = src.strength, reporting_qty = src.reporting_qty,
    reporting_unit = src.reporting_unit, unit_price = src.unit_price, amount = src.amount,
    total_cost = src.total_cost, client_paid = src.client_paid, irx_paid = src.irx_paid,
    vendor_paid = src.vendor_paid, status = src.status, order_status = src.order_status,
    is_paid = src.is_paid, date_ordered = src.date_ordered, shipped_date = src.shipped_date,
    delivery_date = src.delivery_date
WHEN NOT MATCHED THEN INSERT
    (source_id, transaction_number, order_number, customer_id, patient_first, patient_last,
     cardholder_id, member_id, person_code, raw_group_id, group_id, matches_eligibility,
     drug, strength, reporting_qty, reporting_unit, unit_price, amount, total_cost,
     client_paid, irx_paid, vendor_paid, status, order_status, is_paid,
     date_ordered, shipped_date, delivery_date)
  VALUES
    (src.source_id, src.transaction_number, src.order_number, src.customer_id, src.patient_first, src.patient_last,
     src.cardholder_id, src.member_id, src.person_code, src.raw_group_id, src.group_id,
     CASE WHEN src.group_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM dbo.Eligibility_Liviniti e WHERE e.GroupID = src.group_id) THEN 1 ELSE 0 END,
     src.drug, src.strength, src.reporting_qty, src.reporting_unit, src.unit_price, src.amount, src.total_cost,
     src.client_paid, src.irx_paid, src.vendor_paid, src.status, src.order_status, src.is_paid,
     src.date_ordered, src.shipped_date, src.delivery_date);
"""


def main():
    cn = db()
    cur = cn.cursor()
    before = cur.execute("SELECT COUNT(*) FROM dbo.tp_uf_transactions").fetchone()[0]
    cur.execute(MERGE_SQL)
    after = cur.execute("SELECT COUNT(*) FROM dbo.tp_uf_transactions").fetchone()[0]
    stats = cur.execute(
        """SELECT COUNT(*), SUM(CASE WHEN matches_eligibility=1 THEN 1 ELSE 0 END),
                  COUNT(DISTINCT group_id), CAST(SUM(amount) AS decimal(18,2))
           FROM dbo.tp_uf_transactions""").fetchone()
    print(f"tp_uf_transactions: {before} -> {after} rows ({after-before:+d})")
    print(f"  matched-to-eligibility: {stats[1]} | distinct groups: {stats[2]} | total amount: {stats[3]}")


if __name__ == "__main__":
    main()
