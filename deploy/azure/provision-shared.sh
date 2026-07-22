#!/usr/bin/env bash
# Phase 2a — shared resources: resource group, Azure Container Registry, and
# the first image build (also validates the Dockerfile in the cloud).
# Idempotent: safe to re-run.
#
#   ./deploy/azure/provision-shared.sh
#
# Requires: az login as the target user; SUBSCRIPTION_ID set in config.sh.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
source "$HERE/config.sh"
source "$HERE/lib.sh"

require_azure

# ── Resource group ──────────────────────────────────────────────────────────
if group_exists "$SHARED_RG"; then
  log "Resource group $SHARED_RG already exists."
else
  log "Creating resource group $SHARED_RG in $LOCATION"
  az group create --name "$SHARED_RG" --location "$LOCATION" -o none
fi

# ── Azure Container Registry ────────────────────────────────────────────────
if acr_exists "$ACR_NAME"; then
  log "ACR $ACR_NAME already exists."
else
  log "Creating ACR $ACR_NAME (Basic)"
  az acr create --name "$ACR_NAME" --resource-group "$SHARED_RG" \
    --sku Basic --admin-enabled false -o none
fi
ACR_LOGIN_SERVER="$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)"
log "ACR login server: $ACR_LOGIN_SERVER"

# ── Initial image build (cloud build — no local Docker needed) ──────────────
# Tag with the current git sha plus 'latest' so envs can pin an immutable tag.
TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo manual)"
log "Building image $IMAGE_REPO:$TAG (+ latest) from $REPO_ROOT"
az acr build \
  --registry "$ACR_NAME" \
  --image "$IMAGE_REPO:$TAG" \
  --image "$IMAGE_REPO:latest" \
  "$REPO_ROOT"

log "Done. Image pushed: $ACR_LOGIN_SERVER/$IMAGE_REPO:$TAG"
log "Next: ./deploy/azure/provision-env.sh dev   (then staging, prod)"
