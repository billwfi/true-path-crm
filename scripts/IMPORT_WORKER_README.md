# Eligibility & Claims Import Worker

`import_worker.py` runs on the SQL box (stable IP so client SFTP servers can
whitelist it). It reads feed configs created in the web app under
**Eligibility & Claims Imports → Imports**, pulls matching files from each
client's SFTP, maps columns, and inserts them into the configured target table.
Every execution is recorded in `dbo.Import_Runs` and shown in the app's Run History.

## Install (once, on the SQL box)

```bash
pip install -r scripts/requirements-import-worker.txt
# Microsoft ODBC Driver 17 for SQL Server must also be installed.
```

## Environment

```
IRX_DB_PWD=<SQL Server password for claudeservices>
IMPORT_CRYPT_KEY=<64 hex chars — MUST equal the Netlify env var of the same name>
```

`IMPORT_CRYPT_KEY` is what lets the worker decrypt the SFTP passwords the app
stored. It must be byte-for-byte identical to the value set in Netlify.

Optional: `SQLSERVER_HOST` (default `74.117.224.152`), `SQLSERVER_DB` (`irx`),
`SQLSERVER_USER` (`claudeservices`).

## Run

```bash
python scripts/import_worker.py                  # run every config that is due now
python scripts/import_worker.py --config 3       # run config 3 if due
python scripts/import_worker.py --config 3 --force   # run config 3 now, ignore schedule
```

Schedule it frequently and let each config's own schedule decide when it runs.

**Windows Task Scheduler** — run every 15 minutes:
```
schtasks /Create /SC MINUTE /MO 15 /TN "CRM Import Worker" ^
  /TR "python C:\path\to\true-path-crm\scripts\import_worker.py"
```

**cron** (Linux) — every 15 minutes:
```
*/15 * * * *  cd /path/to/true-path-crm && python scripts/import_worker.py >> /var/log/crm-import.log 2>&1
```

## How "due" is decided
- **Hourly** — runs if it hasn't run in the last 55 minutes.
- **Daily** — runs once per day at/after the configured time.
- **Weekly** — runs once on the configured weekday at/after the configured time.

A config can also be run on demand: the **Run now** button in the app sets
`run_requested = 1`, and the worker runs that config on its next pass (even if
inactive or not yet due) and clears the flag.

Already-imported files are tracked in `dbo.Import_Processed_Files` (by name per
config) and are never re-imported. `after_import` can leave, delete, or archive
the remote file.

## Header & footer handling
- **header_row** — 1-based file row of the column header; rows above it (report
  titles, blank lines) are ignored. Data starts on the next row.
- **stop_on_blank** — end the data at the first fully-blank row after the header.
- **stop_marker** — end the data at the first row whose first value starts with
  this text (case-insensitive), e.g. `Total`.
- **footer_skip** — drop this many trailing rows (totals/notes) from the end.
