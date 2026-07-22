#!/usr/bin/env sh
# Container Apps Job entrypoint for the client SFTP import + reconcile pipeline.
# Driven by env vars so the same image serves every client and both modes:
#   CLIENT       client key in the CLIENTS/RECON registries (default: mcrhotels)
#   RECON_FLAGS  passed to reconcile.py; empty = DRY RUN (safe).
#                Set to "--commit --send" to write prod eligibility/claims + email.
# Secrets (IRX_DB_PWD, MCR_SFTP_PWD, SMTP_PASS) come from Container App secrets.
set -e
CLIENT="${CLIENT:-mcrhotels}"

echo ">>> [$(date -u +%FT%TZ)] SFTP import: $CLIENT"
python scripts/client_imports/sftp_import.py "$CLIENT"

echo ">>> [$(date -u +%FT%TZ)] Reconcile: $CLIENT ${RECON_FLAGS:-(dry run)}"
# shellcheck disable=SC2086
python scripts/client_imports/reconcile.py "$CLIENT" $RECON_FLAGS

echo ">>> [$(date -u +%FT%TZ)] Done."
