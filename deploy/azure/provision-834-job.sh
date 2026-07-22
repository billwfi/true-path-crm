#!/usr/bin/env bash
# Phase 5 (834 feeds) — create/refresh the weekly scheduled Container Apps Job
# that pulls a client's 834 from SFTP, parses it, and reconciles into prod.
# Currently: Anders (caj-tpcrm-anders), Mondays 07:00 UTC.
#
#   ./deploy/azure/provision-834-job.sh
#
# Prereqs: az login as the target user; the tpcrm-jobs image already built
# (deploy/azure/provision-jobs.sh builds it). Secrets from deploy/azure/env.jobs.
#
# NOTE on ordering: a job created with --registry-identity system BEFORE its
# managed identity has AcrPull will silently fall back to the quickstart image
# (symptom: executions just log "Listening on :80"). So we create -> grant
# AcrPull -> set the real image, in that order.
set -euo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/config.sh"; source "$HERE/lib.sh"

ENV_FILE="$HERE/env.jobs"
[[ -f "$ENV_FILE" ]] || die "Missing $ENV_FILE (IRX_DB_PWD, SFTP pwd, SMTP_PASS)."
set -a; source "$ENV_FILE"; set +a
SFTP_PWD="${SFTP_PWD:-${MCR_SFTP_PWD:-$IRX_DB_PWD}}"

require_azure
JOB="caj-tpcrm-anders"; RG="rg-tpcrm-prod"; CAE="cae-tpcrm-prod"
ACR_LOGIN_SERVER="$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)"
ACRID="$(az acr show --name "$ACR_NAME" --query id -o tsv)"
IMG="$ACR_LOGIN_SERVER/tpcrm-jobs:latest"
CRON="${ANDERS_CRON:-0 7 * * 1}"   # Mondays 07:00 UTC

if az containerapp job show -n "$JOB" -g "$RG" >/dev/null 2>&1; then
  log "Updating $JOB"
  az containerapp job secret set -n "$JOB" -g "$RG" \
    --secrets irx-db-pwd="$IRX_DB_PWD" sftp-pwd="$SFTP_PWD" smtp-pass="$SMTP_PASS" -o none
  az containerapp job update -n "$JOB" -g "$RG" --image "$IMG" \
    --set-env-vars PIPELINE=834 CLIENT=anders -o none
else
  log "Creating $JOB (placeholder image first, then AcrPull, then real image)"
  # 1) create with system identity (starts on the quickstart placeholder)
  az containerapp job create -n "$JOB" -g "$RG" --environment "$CAE" \
    --trigger-type Schedule --cron-expression "$CRON" \
    --replica-timeout 3600 --replica-retry-limit 1 --parallelism 1 --replica-completion-count 1 \
    --mi-system-assigned --cpu 0.5 --memory 1.0Gi \
    --secrets irx-db-pwd="$IRX_DB_PWD" sftp-pwd="$SFTP_PWD" smtp-pass="$SMTP_PASS" \
    --env-vars PIPELINE=834 CLIENT=anders IRX_DB_PWD=secretref:irx-db-pwd \
      SFTP_PWD=secretref:sftp-pwd SMTP_PASS=secretref:smtp-pass \
      SMTP_HOST=smtp.office365.com SMTP_PORT=587 \
      SMTP_USER=onbasesupport@internationalrx.com MAIL_FROM=onbasesupport@internationalrx.com \
    -o none
  # 2) grant AcrPull to the job's managed identity
  PID="$(az containerapp job show -n "$JOB" -g "$RG" --query identity.principalId -o tsv)"
  az role assignment create --assignee-object-id "$PID" --assignee-principal-type ServicePrincipal \
    --role AcrPull --scope "$ACRID" -o none 2>/dev/null || true
  # 3) bind registry via identity + set the real image
  az containerapp job registry set -n "$JOB" -g "$RG" --server "$ACR_LOGIN_SERVER" --identity system -o none
  az containerapp job update -n "$JOB" -g "$RG" --image "$IMG" -o none
fi

log "Done. $JOB — schedule '$CRON', image $IMG."
log "Manual run: az containerapp job start -n $JOB -g $RG"
log "Dry-run test: az containerapp job update -n $JOB -g $RG --set-env-vars 'RECON_FLAGS=' ; start ; then --remove-env-vars RECON_FLAGS"
