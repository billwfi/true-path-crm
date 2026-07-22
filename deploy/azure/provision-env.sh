#!/usr/bin/env bash
# Phase 2b — provision (or update) one environment: dev | staging | prod.
# Creates the resource group, the Container Apps environment, and the Container
# App itself with per-env secrets. Idempotent: re-running updates in place.
#
#   ./deploy/azure/provision-env.sh dev
#
# Secrets/config for the env are read from deploy/azure/env.<env> (gitignored).
# Copy env.example to env.dev / env.staging / env.prod and fill it in first.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/config.sh"
source "$HERE/lib.sh"

ENV="${1:-}"
case "$ENV" in
  dev|staging|prod) ;;
  *) die "Usage: $0 <dev|staging|prod>" ;;
esac

ENV_FILE="$HERE/env.$ENV"
[[ -f "$ENV_FILE" ]] || die "Missing $ENV_FILE. Copy env.example to env.$ENV and fill it in."
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

# Required values from the env file.
for v in JWT_SECRET ADMIN_EMAIL ADMIN_PASSWORD IMPORT_CRYPT_KEY \
         SQLSERVER_HOST SQLSERVER_DB SQLSERVER_USER SQLSERVER_PASSWORD SQLSERVER_PORT; do
  [[ -n "${!v:-}" ]] || die "Env file $ENV_FILE is missing $v"
done

require_azure
acr_exists "$ACR_NAME" || die "ACR $ACR_NAME not found — run provision-shared.sh first."
ACR_LOGIN_SERVER="$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)"
IMAGE="${IMAGE:-$ACR_LOGIN_SERVER/$IMAGE_REPO:latest}"

RG="$(env_rg "$ENV")"; CAE="$(env_cae "$ENV")"; APP="$(env_app "$ENV")"

# ── Resource group ──────────────────────────────────────────────────────────
if group_exists "$RG"; then log "RG $RG exists."; else
  log "Creating RG $RG"; az group create --name "$RG" --location "$LOCATION" -o none
fi

# ── Container Apps environment (auto-creates a Log Analytics workspace) ─────
if cae_exists "$CAE" "$RG"; then log "Container Apps env $CAE exists."; else
  log "Creating Container Apps env $CAE"
  az containerapp env create --name "$CAE" --resource-group "$RG" \
    --location "$LOCATION" -o none
fi

# Secret name -> value map (secret values never appear as plain env vars).
SECRETS=(
  "jwt-secret=$JWT_SECRET"
  "admin-password=$ADMIN_PASSWORD"
  "import-crypt-key=$IMPORT_CRYPT_KEY"
  "sqlserver-password=$SQLSERVER_PASSWORD"
)
# Env vars: secretrefs for sensitive ones, plain for the rest.
ENVVARS=(
  "NODE_ENV=production"
  "JWT_SECRET=secretref:jwt-secret"
  "ADMIN_PASSWORD=secretref:admin-password"
  "IMPORT_CRYPT_KEY=secretref:import-crypt-key"
  "SQLSERVER_PASSWORD=secretref:sqlserver-password"
  "ADMIN_EMAIL=$ADMIN_EMAIL"
  "SQLSERVER_HOST=$SQLSERVER_HOST"
  "SQLSERVER_DB=$SQLSERVER_DB"
  "SQLSERVER_USER=$SQLSERVER_USER"
  "SQLSERVER_PORT=$SQLSERVER_PORT"
)

if app_exists "$APP" "$RG"; then
  log "Updating existing app $APP"
  az containerapp secret set --name "$APP" --resource-group "$RG" \
    --secrets "${SECRETS[@]}" -o none
  az containerapp update --name "$APP" --resource-group "$RG" \
    --image "$IMAGE" --set-env-vars "${ENVVARS[@]}" \
    --min-replicas "$MIN_REPLICAS" --max-replicas "$MAX_REPLICAS" -o none
else
  log "Creating app $APP (image $IMAGE)"
  az containerapp create --name "$APP" --resource-group "$RG" --environment "$CAE" \
    --image "$IMAGE" \
    --registry-server "$ACR_LOGIN_SERVER" --registry-identity system \
    --system-assigned \
    --ingress external --target-port "$TARGET_PORT" \
    --min-replicas "$MIN_REPLICAS" --max-replicas "$MAX_REPLICAS" \
    --cpu "$CPU" --memory "$MEMORY" \
    --secrets "${SECRETS[@]}" \
    --env-vars "${ENVVARS[@]}" -o none
fi

FQDN="$(az containerapp show --name "$APP" --resource-group "$RG" \
  --query properties.configuration.ingress.fqdn -o tsv)"
log "Done. $ENV is live at: https://$FQDN"
