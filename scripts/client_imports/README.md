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
- SFTP: `us-east-1.sftpcloud.io`, user `MANAGER`, dir `/InternationalRx/MCRHotels`
  (username and path are **case-sensitive**).
- `MCR_Member*.xlsx`   → `dbo.Eligibility_MCRHotels` (roster is on the `Detail`
  sheet, not the first `Cover` sheet). Loaded ~1,747 members.
- `MCRINVESTORS_*.xlsx` → `dbo.ClaimsData_MCRHotels`, plus a computed
  `groupid = LEFT([Group ID], 8)` column. Loaded ~18,938 claims.

Use the `sheet` key on a feed to pick a worksheet by name (e.g. `"Detail"`).

Columns are created from the file's header row (sanitized names, sized to the
data). Use `--recreate` if a file's columns change (DROP + CREATE instead of
TRUNCATE).

## Run log

Every feed run writes a row to `dbo.Client_Import_Log` (migration
`netlify/database/sqlserver/016_client_import_log.sql`): GroupID
(`tp_clients.irx_client_id`), group name, feed, file processed, record count,
status, and start/finish timestamps — linked to the client via `client_id`
(set in the registry) so the CRM client page can surface import history.

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
