#!/usr/bin/env bash
# Shared configuration for the Azure Container Apps provisioning scripts.
# Sourced by provision-shared.sh and provision-env.sh. Override any value by
# exporting it before you run, e.g.  ACR_NAME=acrtpcrm123 ./provision-shared.sh
set -euo pipefail

# ── Target subscription ─────────────────────────────────────────────────────
# Subscription 1 under bwalker@truepathsourcing.com. Set this so the scripts
# NEVER provision into whatever subscription happens to be the CLI default.
# Find it with:  az account list -o table
SUBSCRIPTION_ID="${SUBSCRIPTION_ID:-7166b785-9254-4943-9d61-62e668b7ca58}"

# Expected signed-in user — a guard so we don't build in the wrong tenant.
EXPECTED_USER="${EXPECTED_USER:-bwalker@truepathsourcing.com}"

LOCATION="${LOCATION:-eastus2}"
PROJECT="tpcrm"

# ── Shared resources (one ACR, promoted across all envs) ────────────────────
SHARED_RG="${SHARED_RG:-rg-${PROJECT}-shared}"
# ACR name must be GLOBALLY UNIQUE, 5-50 chars, lowercase alphanumeric only.
ACR_NAME="${ACR_NAME:-acrtpcrm}"
IMAGE_REPO="${IMAGE_REPO:-tpcrm}"

# ── Container sizing ────────────────────────────────────────────────────────
TARGET_PORT="${TARGET_PORT:-8080}"
MIN_REPLICAS="${MIN_REPLICAS:-1}"   # 1 keeps the mssql pool warm (no cold start)
MAX_REPLICAS="${MAX_REPLICAS:-3}"
CPU="${CPU:-0.5}"
MEMORY="${MEMORY:-1.0Gi}"

# ── Per-environment names (derived from the env: dev|staging|prod) ──────────
env_rg()  { echo "rg-${PROJECT}-$1"; }
env_cae() { echo "cae-${PROJECT}-$1"; }
env_app() { echo "ca-${PROJECT}-$1"; }
