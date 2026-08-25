# Claims & Eligibility Pipeline — canonical design (READ THIS FIRST)

This is the ONE intended flow for every client. It keeps getting re-invented per
session; do not deviate. `reconcile.py` is the reference implementation.

## The flow (every client, every Monday)

```
SFTP sweep (claims + eligibility)                    scripts/import_monday.py
   └─ new file for a client?
        ├─ CLAIMS:      load raw → dbo.ClaimsData_<Client>   (client-specific, add-only)
        │                 then reconcile → dbo.ClaimsData_Prod (ADD NEW ONLY)
        └─ ELIGIBILITY: load raw → dbo.Eligibility_<Client>  (client-specific staging)
                          then reconcile → dbo.eligibility     (ADD / UPDATE / INACTIVATE)
   └─ email the reconciliation report to the distro, ONE email per client processed
```

**The app reads `dbo.ClaimsData_Prod` and `dbo.eligibility` — NOT the client-specific
tables.** A client-specific claims table that the app reads directly (via a
`claims.js` SOURCES entry pointing at `ClaimsData_<Client>`) is drift and must be
migrated to read `ClaimsData_Prod`.

## Reconcile rules (exactly what reconcile.py does)

**Eligibility** — client staging → `dbo.eligibility`, keyed `CARRIER` + `MEMBER_ID`
(`carrier` = the client's `irx_client_id`):
- in file, NOT in eligibility → **INSERT** (`LoadUpdateDate = today`, `AccountStatus='Active'`)
- in file AND in eligibility → **UPDATE** fields from the file, `AccountStatus='Active'`
  (never overwrite a populated field with a blank: `COALESCE(NULLIF(?, ''), [col])`;
  keep the existing `MEMBER_ID` and `MEMBER_FROM_DATE`)
- in eligibility, NOT in file → **`MEMBER_THRU_DATE = today (file processing date)`,
  `AccountStatus='Inactive'`, `LoadUpdateDate = today`** (this is the termination step)

**Claims** — client-specific `ClaimsData_<Client>` → `dbo.ClaimsData_Prod`, keyed
`clientid` + the claim-line key. **ADD NEW ONLY** — never update/delete existing prod
rows. Map the columns that line up (see `reconcile.py` RECON maps), rest stay NULL,
`LoadUpdateDate = today` on inserts. `ClaimsData_Prod` has **no cost columns** (Plan
Paid / Gross Cost / Copay are dropped) — see the open decision below.

## Table naming
- Claims client-specific: `dbo.ClaimsData_<Client>` (all varchar; holds the raw feed,
  incl. cost columns the vendor sends).
- Claims canonical (app reads): `dbo.ClaimsData_Prod` (normalized, all varchar, keyed
  on lowercase `clientid`; column names are lowercase-no-space e.g. `dateofservice`).
- Eligibility client-specific/staging: `dbo.Eligibility_<Client>` (or `Eligibility834_<Client>` for 834).
- Eligibility canonical (app reads): `dbo.eligibility` (keyed `CARRIER` + `MEMBER_ID`).

## Where the code lives
- `import_monday.py` — the Monday orchestrator (sweep + coverage report + runs loaders/reconciles).
- `claims_loader.py` — loads a claims file into `ClaimsData_<Client>` (the CLAIMS registry).
- `sftp_import.py` / `parse_834.py` — load eligibility feeds into `Eligibility_<Client>` staging.
- `reconcile.py` — the RECON registry: client staging → prod/eligibility + the per-client AMT email.
- `claims.js` SOURCES — maps a carrier to the table the app reads. **Canonical = `ClaimsData_Prod`.**

## Per-client conformance (2026-08-25)

| Client | irx_client_id | Claims path today | Conforms? |
|---|---|---|---|
| MCR Hotels | 76416172 | ClaimsData_MCRHotels → **Prod** | ✅ |
| Anders | 000239911 | ClaimsData_Anders → **Prod** | ✅ |
| RHA | PSI4105 | ClaimsData_RHA → **Prod** | ✅ |
| Harrison Beverage | 2871 | loaded straight into **Prod** (no client table) | ⚠ needs `ClaimsData_Harrison` |
| City of McAllen | PSI3604 | put in shared **ClaimsData** (wrong) | ⚠ FIXED → ClaimsData_McAllen → Prod |
| CSE Americas | 020373 | ClaimsData_CSEAmericas (app reads it directly) | ❌ migrate to Prod |
| City of Mission | 077803 | ClaimsData_CityofMission (direct) | ❌ migrate to Prod |
| Smith County | PSI1022 | ClaimsData_SmithCounty (direct) | ❌ migrate to Prod |
| Gregg County | 366696 | ClaimsData_GreggCounty (direct) | ❌ migrate to Prod |
| Caregiver | 10116 | ClaimsData_Caregiver (direct) | ❌ migrate to Prod |
| FSG | 909765 | ClaimsData_FSG (direct) | ❌ migrate to Prod |

## OPEN DECISION — cost columns in ClaimsData_Prod
`ClaimsData_Prod` has no Plan Paid / Gross Cost / Copay. The direct-read HRx clients
(CSE/Mission/Smith/Gregg/McAllen) currently SHOW costs because the app reads their
client table. Migrating them to `ClaimsData_Prod` drops cost display unless we ADD
cost columns to `ClaimsData_Prod` (and populate them in the reconcile maps + surface
them in `claims.js` claimsProd). Decide before migrating the HRx clients.

## Migration checklist to make a direct-read client conform
1. `ClaimsData_<Client>` already exists (it's the current direct-read table) — keep it.
2. Add a `reconcile.py` RECON `claims` config: map `ClaimsData_<Client>` cols → prod cols, add-only key.
3. Run `reconcile.py <client> --claims-only --commit` → back-fills prod.
4. Repoint `claims.js` SOURCES `<carrier>` → `ClaimsData_Prod` (layout 'prod').
5. Add `<client>` to the claims-reconcile loop in `import_monday.py`.
6. Deploy web via CI (`gh` service-principal path — MFA-exempt; see ci-staging-prod-deploy-stale memory).
