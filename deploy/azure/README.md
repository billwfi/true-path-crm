# Azure Container Apps — provisioning (Phase 2)

Idempotent scripts that stand up the shared registry and the three
environments (dev / staging / prod) for True Path CRM. Written for **bash**
(run in Git Bash, WSL, or Azure Cloud Shell).

## Topology

- **1 shared ACR** in `rg-tpcrm-shared` — build the image once, promote the same
  tag across environments.
- **3 isolated resource groups** `rg-tpcrm-{dev,staging,prod}`, each with its own
  Container Apps environment (`cae-tpcrm-<env>`) and app (`ca-tpcrm-<env>`) with
  its own secret set.
- External HTTPS ingress on port 8080, min 1 / max 3 replicas, ACR pulled via the
  app's **system-assigned managed identity** (no registry passwords stored).

## Prerequisites

1. `az login` **as `bwalker@truepathsourcing.com`** (the scripts refuse to run as
   any other user — see `EXPECTED_USER` in `config.sh`).
2. Set `SUBSCRIPTION_ID` in `config.sh` to Subscription 1
   (`az account list -o table` to find it). This pins the target so nothing is
   ever created in the wrong subscription.
3. Pick a globally-unique `ACR_NAME` in `config.sh` (default `acrtpcrm`).

## Run order

```bash
# 1. Shared registry + first cloud image build (validates the Dockerfile)
./deploy/azure/provision-shared.sh

# 2. One environment at a time. Copy env.example -> env.<env> and fill it in first.
cp deploy/azure/env.example deploy/azure/env.dev      # then edit
./deploy/azure/provision-env.sh dev

cp deploy/azure/env.example deploy/azure/env.staging  # then edit
./deploy/azure/provision-env.sh staging

cp deploy/azure/env.example deploy/azure/env.prod      # then edit
./deploy/azure/provision-env.sh prod
```

Each script is safe to re-run: existing resources are detected and the app is
updated in place (image + secrets + env vars).

## Notes

- `env.dev` / `env.staging` / `env.prod` hold real secrets and are **gitignored**.
- **Non-prod databases:** point dev/staging `SQLSERVER_DB` at a separate database
  or schema so test writes never hit live data. Only prod uses the live DB.
- After provisioning, deploys are automated by GitHub Actions (Phase 3); these
  scripts are for the one-time infra stand-up and manual re-provisioning.
