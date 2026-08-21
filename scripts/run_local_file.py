"""Run an Import_Configs feed against a file already on disk, skipping SFTP.

Same parsing, column mapping, coercion and reconciliation as import_worker.py --
it imports those functions rather than reimplementing them, so what this proves
is what the scheduled worker will do. It only replaces "fetch the file over
SFTP" with "read this path".

Useful for:
  - backfilling a month a vendor emailed instead of dropping on the SFTP
  - re-running a feed after fixing its column maps, without re-uploading
  - testing a new feed's mapping before its credentials are wired up

The two stages can be run separately, which matters when a feed needs manual
work in between (e.g. rekeying legacy rows after staging is loaded but before
reconciliation would inactivate them).

Env: IRX_DB_PWD (required). Optional: SQLSERVER_HOST/_DB/_USER,
     SQLSERVER_ODBC_DRIVER.

Usage:
  python scripts/run_local_file.py --config 1012 --file "C:/path/elig.xlsx"
  python scripts/run_local_file.py --config 1012 --file "..." --stage-only
  python scripts/run_local_file.py --config 1012 --reconcile-only
"""
import argparse
import os
import sys

from import_worker import (
    db_connect, rows_as_dicts, parse_file, import_rows,
    read_stage, reconcile_eligibility,
)


def load_config(cur, config_id):
    cur.execute(
        "SELECT id, client_id, name, feed_type, file_pattern, file_format, delimiter, "
        "has_header, header_row, stop_on_blank, stop_marker, footer_skip, sheet_name, "
        "target_table, reconcile_table, stage_filter, truncate_before "
        "FROM dbo.Import_Configs WHERE id=?", config_id)
    cfgs = rows_as_dicts(cur)
    if not cfgs:
        sys.exit(f"No config with id {config_id}")
    return cfgs[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", type=int, required=True)
    ap.add_argument("--file", help="local file to load (required unless --reconcile-only)")
    ap.add_argument("--stage-only", action="store_true", help="load staging, skip reconcile")
    ap.add_argument("--reconcile-only", action="store_true", help="reconcile existing staging")
    args = ap.parse_args()

    if not args.reconcile_only and not args.file:
        sys.exit("--file is required unless --reconcile-only")

    cn = db_connect()
    cur = cn.cursor()
    cfg = load_config(cur, args.config)
    print(f"Config {cfg['id']}: {cfg['name']}  ({cfg['feed_type']} -> {cfg['target_table']})")

    cur.execute(
        "INSERT INTO dbo.Import_Runs (config_id, status) OUTPUT INSERTED.id VALUES (?, 'Running')",
        cfg["id"])
    run_id = cur.fetchone()[0]

    def finish(status, file_name=None, rows=None, message=None):
        cur.execute(
            "UPDATE dbo.Import_Runs SET finished_at=GETDATE(), status=?, file_name=?, "
            "rows_imported=?, message=? WHERE id=?",
            status, file_name, rows, (message[:3900] if message else None), run_id)

    try:
        staged = None
        if not args.reconcile_only:
            cur.execute(
                "SELECT source_column, target_column, data_type FROM dbo.Import_Column_Maps "
                "WHERE config_id=? ORDER BY ordinal, id", cfg["id"])
            maps = rows_as_dicts(cur)
            if not maps:
                sys.exit("No column mappings defined for this config")

            with open(args.file, "rb") as fh:
                data = fh.read()
            header, body = parse_file(data, cfg)
            print(f"  parsed {len(header)} columns x {len(body)} data rows")
            staged = import_rows(cur, cfg["target_table"], maps, header, body,
                                 truncate=bool(cfg["truncate_before"]))
            print(f"  staged {staged} rows into {cfg['target_table']}")

        if args.stage_only:
            finish("Success", file_name=(os.path.basename(args.file) if args.file else None),
                   rows=staged, message=f"Staged {staged} rows (stage-only, local file)")
            print("  stage-only: stopping before reconcile")
            return

        if cfg["feed_type"] != "Eligibility":
            finish("Success", file_name=os.path.basename(args.file), rows=staged,
                   message=f"Imported {staged} rows (local file)")
            return

        cur.execute(
            "SELECT stage_column, eligibility_column, stage_expression FROM dbo.Import_Reconcile_Maps "
            "WHERE config_id=? ORDER BY ordinal, id", cfg["id"])
        recon_maps = rows_as_dicts(cur)
        if not recon_maps:
            sys.exit("No reconcile mapping defined for this config")

        rows, target_cols = read_stage(cur, cfg["target_table"], recon_maps, cfg.get("stage_filter"))
        print(f"  read {len(rows)} rows from staging for reconciliation")
        added, updated, inactivated = reconcile_eligibility(cur, cfg, run_id, rows, target_cols)
        cur.execute(
            "UPDATE dbo.Import_Runs SET added_count=?, updated_count=?, inactivated_count=? WHERE id=?",
            added, updated, inactivated, run_id)
        msg = (f"{added} added, {updated} updated, {inactivated} inactivated "
               f"-> {cfg.get('reconcile_table') or 'dbo.eligibility'}")
        finish("Success", file_name=(os.path.basename(args.file) if args.file else None),
               rows=staged, message=msg)
        print(f"  {msg}")
    except Exception as e:  # noqa: BLE001 - mirror the worker: record then re-raise
        finish("Error", message=f"{type(e).__name__}: {e}")
        raise
    finally:
        cn.close()


if __name__ == "__main__":
    main()
