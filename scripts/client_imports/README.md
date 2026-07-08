# Client claims / eligibility SFTP imports

Repo-tracked, **rerunnable** setup for pulling a client's eligibility and claims
files from SFTP into per-client SQL Server staging tables.

This is **Step 1** (get new data in). A later **Step 2** compares these staging
tables to the production `eligibility` / `claimsdata_prod` tables and emails a
reconciliation report to the AMT team — that lives in a separate script.

## How it works

`sftp_import.py` holds a `CLIENTS` registry. Each client has one or more feeds;
each feed pulls the **newest** file matching a glob from the client's SFTP folder
and loads it into a table. **Each run truncates the target table and reloads it**,
so the table always holds the latest file (the table is created on first run).

Add a new client by appending to `CLIENTS` — no other code changes.

## Clients

### MCR Hotels (`mcrhotels`)
- SFTP: `us-east-1.sftpcloud.io`, user `manager`, dir `/internationalrx/mcrhotels`
- `MCR_Member*.xlsx`   → `dbo.Eligibility_MCRHotels`
- `MCRINVESTORS_*.xlsx` → `dbo.ClaimsData_MCRHotels`, plus a computed
  `groupid = SUBSTRING([group id], 1, 8)` column.

Columns are created from the file's header row (sanitized names, sized to the
data). Use `--recreate` if a file's columns change (DROP + CREATE instead of
TRUNCATE).

## Running

```bash
# Secrets come from env vars — never commit them.
export IRX_DB_PWD=...          # SQL Server 'claudeservices' password
export MCR_SFTP_PWD=...        # MCR Hotels SFTP password

python scripts/client_imports/sftp_import.py mcrhotels             # all feeds
python scripts/client_imports/sftp_import.py mcrhotels Claims      # one feed
python scripts/client_imports/sftp_import.py mcrhotels --recreate  # schema changed
```

DB defaults (override via env): `SQLSERVER_HOST=74.117.224.152`, `SQLSERVER_DB=irx`,
`SQLSERVER_USER=claudeservices`.

Requires: `pip install pyodbc paramiko openpyxl` (+ ODBC Driver 17 for SQL Server).
