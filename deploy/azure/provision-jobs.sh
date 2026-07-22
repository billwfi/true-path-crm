#!/usr/bin/env bash
# Phase 5 — build the Python pipelines image and deploy the client import +
# reconcile pipeline as a Container Apps Job (manual trigger).
# Idempotent: re-running rebuilds the image and updates the job in place.
#
#   ./deploy/azure/provision-jobs.sh
#
# Secrets come from deploy/azure/env.jobs (gitignored): IRX_DB_PWD, MCR_SFTP_PWD, SMTP_PASS.
# The job runs the pipeline in DRY-RUN by default (no RECON_FLAGS). To go live:
#   az containerapp job update -n caj-tpcrm-imports -g rg-tpcrm-prod \
#     --set-env-vars RECON_FLAGS="--commit --send"
# Trigger a run:  az containerapp job start -n caj-tpcrm-imports -g rg-tpcrm-prod
set -euo pipefail
# NOTE: do NOT set MSYS_NO_PATHCONV here — az acr build needs the build-context
# path converted to a Windows path on Git Bash. (This script has no ARM /scope
# args, so path conversion is safe.)
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# az streams ACR build logs; on Windows consoles (cp1252) pip's Unicode progress
# bars crash the CLI mid-stream. Force UTF-8 so log streaming survives.
export PYTHONIOENCODING=utf-8 PYTHONUTF8=1
source "$HERE/config.sh"; source "$HERE/lib.sh"

ENV_FILE="$HERE/env.jobs"
[[ -f "$ENV_FILE" ]] || die "Missing $ENV_FILE (IRX_DB_PWD, MCR_SFTP_PWD, SMTP_PASS)."
set -a; source "$ENV_FILE"; set +a
for v in IRX_DB_PWD MCR_SFTP_PWD SMTP_PASS; do [[ -n "${!v:-}" ]] || die "$ENV_FILE missing $v"; done

require_azure
JOB="caj-tpcrm-imports"; RG="rg-tpcrm-prod"; CAE="cae-tpcrm-prod"

# ── Build the jobs image in ACR (validates the Dockerfile + ODBC install) ───
TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo manual)"
log "Building tpcrm-jobs:$TAG"
az acr build --registry "$ACR_NAME" \
  --image "tpcrm-jobs:$TAG" --image "tpcrm-jobs:latest" \
  -f "$REPO_ROOT/deploy/jobs/Dockerfile" "$REPO_ROOT"

ACR_LOGIN_SERVER="$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)"
IMG="$ACR_LOGIN_SERVER/tpcrm-jobs:$TAG"

SECRETS=( "irx-db-pwd=$IRX_DB_PWD" "mcr-sftp-pwd=$MCR_SFTP_PWD" "smtp-pass=$SMTP_PASS" )
# RECON_FLAGS intentionally omitted -> pipeline runs DRY-RUN until set live.
ENVVARS=(
  "IRX_DB_PWD=secretref:irx-db-pwd"
  "MCR_SFTP_PWD=secretref:mcr-sftp-pwd"
  "SMTP_PASS=secretref:smtp-pass"
  "SMTP_HOST=smtp.office365.com" "SMTP_PORT=587"
  "SMTP_USER=onbasesupport@internationalrx.com"
  "MAIL_FROM=onbasesupport@internationalrx.com"
  "CLIENT=mcrhotels"
)

if az containerapp job show -n "$JOB" -g "$RG" >/dev/null 2>&1; then
  log "Updating job $JOB"
  az containerapp job secret set -n "$JOB" -g "$RG" --secrets "${SECRETS[@]}" -o none
  az containerapp job update -n "$JOB" -g "$RG" --image "$IMG" \
    --set-env-vars "${ENVVARS[@]}" -o none
else
  log "Creating job $JOB (manual trigger)"
  az containerapp job create -n "$JOB" -g "$RG" --environment "$CAE" \
    --trigger-type Manual --replica-timeout 3600 --replica-retry-limit 1 \
    --parallelism 1 --replica-completion-count 1 \
    --image "$IMG" --cpu 0.5 --memory 1.0Gi \
    --registry-server "$ACR_LOGIN_SERVER" --registry-identity system --system-assigned \
    --secrets "${SECRETS[@]}" --env-vars "${ENVVARS[@]}" -o none
fi

log "Done. Trigger:  az containerapp job start -n $JOB -g $RG"
log "Dry-run by default; go live with --set-env-vars RECON_FLAGS=\"--commit --send\""
