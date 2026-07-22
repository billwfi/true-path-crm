#!/usr/bin/env bash
# Shared helpers: logging, login/subscription guards, existence checks.
set -euo pipefail

log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# Ensure the CLI is logged in, on the RIGHT account, and pinned to the target
# subscription. This is the guardrail against provisioning into the wrong tenant.
require_azure() {
  command -v az >/dev/null || die "azure-cli (az) not found on PATH."

  local acct
  acct="$(az account show 2>/dev/null)" || die "Not logged in. Run: az login"

  local user
  user="$(printf '%s' "$acct" | az account show --query user.name -o tsv 2>/dev/null || true)"
  if [[ -n "${EXPECTED_USER:-}" && "$user" != "$EXPECTED_USER" ]]; then
    die "Signed in as '$user' but EXPECTED_USER='$EXPECTED_USER'.
     Run:  az login  (as $EXPECTED_USER), or export EXPECTED_USER to override."
  fi

  if [[ -n "${SUBSCRIPTION_ID:-}" ]]; then
    az account set --subscription "$SUBSCRIPTION_ID" \
      || die "Could not select subscription $SUBSCRIPTION_ID"
  else
    warn "SUBSCRIPTION_ID not set — using the CLI default subscription:
       $(az account show --query '[name,id]' -o tsv | paste -sd' ')
     Set SUBSCRIPTION_ID in config.sh to pin the target explicitly."
  fi
  log "Using subscription: $(az account show --query '[name,id]' -o tsv | paste -sd' ')"
}

group_exists() { az group exists --name "$1" -o tsv | grep -qx true; }
acr_exists()   { az acr show --name "$1" >/dev/null 2>&1; }
cae_exists()   { az containerapp env show --name "$1" --resource-group "$2" >/dev/null 2>&1; }
app_exists()   { az containerapp show --name "$1" --resource-group "$2" >/dev/null 2>&1; }
