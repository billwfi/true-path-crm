#!/usr/bin/env bash
# Phase 4 — bind custom domains + issue free managed certificates.
# Run AFTER the GoDaddy DNS records (CNAME <sub> + TXT asuid.<sub>) are live.
# Idempotent: re-running re-checks DNS and skips hostnames already bound.
#
#   ./deploy/azure/bind-domains.sh            # verify DNS + bind all that are ready
#   ./deploy/azure/bind-domains.sh app        # just one (app|dev|staging)
set -euo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/config.sh"
source "$HERE/lib.sh"
require_azure

DOMAIN="truepathsourcing.com"
# sub -> env
declare -A ENVOF=( [app]=prod [dev]=dev [staging]=staging )

targets=( "${@:-app dev staging}" )
# normalize (allow no-arg -> all)
[[ $# -eq 0 ]] && targets=(app dev staging)

for sub in "${targets[@]}"; do
  env="${ENVOF[$sub]:-}"; [[ -z "$env" ]] && { warn "unknown target '$sub'"; continue; }
  APP="$(env_app "$env")"; RG="$(env_rg "$env")"; CAE="$(env_cae "$env")"
  HOST="$sub.$DOMAIN"
  APPFQDN="$(az containerapp show -n "$APP" -g "$RG" --query properties.configuration.ingress.fqdn -o tsv)"
  VID="$(az containerapp show -n "$APP" -g "$RG" --query properties.customDomainVerificationId -o tsv)"

  # DNS check via Google DNS-over-HTTPS (portable; avoids Windows nslookup
  # truncating long TXT records — the reason a native nslookup check false-fails).
  log "[$HOST] checking DNS…"
  CNAME_OK=$(curl -s "https://dns.google/resolve?name=$HOST&type=CNAME" | grep -io "$APPFQDN" || true)
  TXT_OK=$(curl -s "https://dns.google/resolve?name=asuid.$HOST&type=TXT" | grep -io "$VID" || true)
  if [[ -z "$CNAME_OK" ]]; then warn "[$HOST] CNAME -> $APPFQDN not visible yet; skipping."; continue; fi
  if [[ -z "$TXT_OK" ]];   then warn "[$HOST] TXT asuid.$HOST not visible yet; skipping."; continue; fi

  # Already bound?
  if az containerapp hostname list -n "$APP" -g "$RG" --query "[?name=='$HOST']" -o tsv | grep -q .; then
    log "[$HOST] already bound; ensuring cert…"
  else
    log "[$HOST] adding hostname…"
    az containerapp hostname add -n "$APP" -g "$RG" --hostname "$HOST" -o none 2>/dev/null || true
  fi

  log "[$HOST] binding + creating managed certificate (CNAME validation)…"
  az containerapp hostname bind -n "$APP" -g "$RG" --hostname "$HOST" \
    --environment "$CAE" --validation-method CNAME -o none
  log "[$HOST] done. (Managed cert provisioning takes a few minutes.)"
done

echo ""
log "Custom domains on each app:"
for sub in "${targets[@]}"; do
  env="${ENVOF[$sub]:-}"; [[ -z "$env" ]] && continue
  az containerapp hostname list -n "$(env_app "$env")" -g "$(env_rg "$env")" \
    --query "[].{host:name, binding:bindingType}" -o tsv 2>/dev/null | sed "s/^/  /"
done
