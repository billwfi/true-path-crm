"""One-off loader: utm_data_fromwellsync CSV -> SQL Server table wellsync_data_June.

Usage: python scripts/load_wellsync.py <path-to-csv>
"""
import csv
import sys
import pyodbc

CSV_PATH = sys.argv[1] if len(sys.argv) > 1 else \
    r"C:\Users\billwalker\Downloads\utm_data_fromwellsync_06192026.csv"

import os
CONN = (
    "DRIVER={ODBC Driver 17 for SQL Server};"
    "SERVER=74.117.224.152;"
    "DATABASE=irx;"
    "UID=claudeservices;"
    "PWD=" + os.environ["IRX_DB_PWD"] + ";"
    "Encrypt=yes;TrustServerCertificate=yes;"
)

# (sanitized column name, SQL type) in CSV header order
COLUMNS = [
    ("patient_dob", "NVARCHAR(32)"),
    ("patient_email", "NVARCHAR(256)"),
    ("patient_fullname", "NVARCHAR(256)"),
    ("patient_gender", "NVARCHAR(32)"),
    ("patient_phone", "NVARCHAR(64)"),
    ("patient_rxpersonid", "NVARCHAR(64)"),
    ("patient_user_detail_address", "NVARCHAR(MAX)"),
    ("service_id", "NVARCHAR(32)"),
    ("service_service_name", "NVARCHAR(256)"),
    ("service_type", "NVARCHAR(128)"),
    ("pharmacy_name", "NVARCHAR(256)"),
    ("pharmacy_address", "NVARCHAR(512)"),
    ("pharmacy_phone", "NVARCHAR(64)"),
    ("status", "NVARCHAR(64)"),
    ("client_name", "NVARCHAR(128)"),
    ("service", "NVARCHAR(MAX)"),
    ("provider", "NVARCHAR(MAX)"),
    ("patient", "NVARCHAR(MAX)"),
    ("transaction_raw", "NVARCHAR(MAX)"),
    ("is_completed", "NVARCHAR(8)"),
    ("updated_at", "NVARCHAR(64)"),
    ("created_at", "NVARCHAR(64)"),
    ("completed_at", "NVARCHAR(64)"),
    ("provider_assigned_at", "NVARCHAR(64)"),
]
TABLE = "wellsync_data_June"


def main():
    with open(CSV_PATH, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.reader(f)
        header = next(reader)
        if len(header) != len(COLUMNS):
            sys.exit(f"Header has {len(header)} cols, expected {len(COLUMNS)}: {header}")
        rows = [tuple((c if c != "" else None) for c in r) for r in reader]
    print(f"Parsed {len(rows)} data rows from {CSV_PATH}")

    cn = pyodbc.connect(CONN, autocommit=False)
    cur = cn.cursor()

    cur.execute(
        "IF OBJECT_ID(?, 'U') IS NOT NULL DROP TABLE " + f"[{TABLE}]",
        f"dbo.{TABLE}",
    )
    coldefs = ",\n  ".join(f"[{n}] {t}" for n, t in COLUMNS)
    cur.execute(f"CREATE TABLE [{TABLE}] (\n  {coldefs}\n)")

    placeholders = ", ".join("?" for _ in COLUMNS)
    collist = ", ".join(f"[{n}]" for n, _ in COLUMNS)
    insert = f"INSERT INTO [{TABLE}] ({collist}) VALUES ({placeholders})"
    cur.fast_executemany = True
    cur.executemany(insert, rows)
    cn.commit()

    cur.execute(f"SELECT COUNT(*) FROM [{TABLE}]")
    count = cur.fetchone()[0]
    print(f"Loaded. [{TABLE}] now has {count} rows.")
    cn.close()


if __name__ == "__main__":
    main()
