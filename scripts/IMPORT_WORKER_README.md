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

## Eligibility reconciliation (two-stage)
For `feed_type = 'Eligibility'` the worker runs two stages:

**Stage 1 — raw load.** The file is loaded into the feed's `target_table` (the
per-client staging table) using the file→staging column map (`Import_Column_Maps`).
The staging table is truncated first, so it holds only the current roster.

**Stage 2 — reconcile.** The staging table is projected onto canonical eligibility
columns via `Import_Reconcile_Maps` (staging column → eligibility column) and
compared to `reconcile_table` (default `dbo.eligibility`), scoped to the client by
`CARRIER = tp_clients.irx_client_id`, keyed on **CARRIER + MEMBER_ID**:

- staged member **not** in eligibility → **INSERT** (CARRIER set, `LoadUpdateDate` = today)
- staged member already present → **UPDATE** mapped fields (`LoadUpdateDate` = today)
- eligibility member missing from the staged roster and still active
  (MEMBER_THRU_DATE blank or a future date) → **INACTIVATE**: `MEMBER_THRU_DATE`
  = run date (`M/D/YYYY`)

The reconcile map **must** include a row whose eligibility column is `MEMBER_ID`.
Per-run counts land on `dbo.Import_Runs`; the Add/Inactivate detail in
`dbo.Import_Reconcile_Items` (app **Report** button, with CSV export). Multiple new
files are combined into one staged roster before reconciling.

## Header & footer handling
- **header_row** — 1-based file row of the column header; rows above it (report
  titles, blank lines) are ignored. Data starts on the next row.
- **stop_on_blank** — end the data at the first fully-blank row after the header.
- **stop_marker** — end the data at the first row whose first value starts with
  this text (case-insensitive), e.g. `Total`.
- **footer_skip** — drop this many trailing rows (totals/notes) from the end.
