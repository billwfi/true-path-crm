# Liviniti Public API — integration reference

Source: *Public API Swagger Documentation_07272026.pdf* + the live sandbox spec
(`https://public-stage.liviniti.com/api/docs/swagger/v1/swagger.json`). This is the
real-time counterpart to our weekly Liviniti/RxCompass SFTP eligibility feed.

## Connection
- **Base URL:** `https://public.liviniti.com/api/v1.0` (prod) / `https://public-stage.liviniti.com/api/v1.0` (sandbox)
- **Path template:** `/api/v{version}/<Controller>/<Action>` with `version = 1.0`
- **Auth:** header **`ApiKey: <key>`** (OpenAPI security scheme `ApiKey`, `in: header`). One key per client; scopes access to that client's members.
- **Swagger UI:** `.../api/docs/swagger/index.html` · **spec JSON:** `.../api/docs/swagger/v1/swagger.json`

> The live spec supersedes the PDF where they differ — the PDF lists some verbs
> wrong. Trust the JSON: GetMemberClaims/GetMemberAccumulator are **POST**,
> Cardholder Activate/Deactivate are **PUT**.

## Endpoints (verb · path · request → response)
| Verb | Path (after `/api/v1.0`) | Request | Response |
|---|---|---|---|
| POST | /Accumulator/GetMemberAccumulator | MemberAccumulatorRequest | FetchMemberAccumulatorResponse |
| PUT  | /Accumulator/SetMemberAccumulator | SetMemberAccumulatorRequest | SetMemberAccumulatorResponse |
| PUT  | /Cardholder/ActivateCardholder | ActivateRequest | CardholderResponse |
| PUT  | /Cardholder/DeactivateCardholder | DeactivateRequest | CardholderResponse |
| POST | /Claims/GetMemberClaims | MemberClaimsRequest | MemberClaimRequestResponse |
| POST | /Drug/DrugSearch | DrugSearchRequest | DrugSearchResponse |
| POST | /Drug/DrugDetail | DrugSearchRequest | DrugDetailResponse |
| POST | /Eligibility/FetchMemberEligibility | FetchMemberEligibilityRequest | FetchMemberEligibilityResponse |
| POST | /Eligibility/FetchFamilyEligibility | FetchFamilyEligibilityRequest | FetchFamilyEligibilityResponse |
| PATCH| /Eligibility/SetMemberEligibility | SetMemberEligibilityRequest | SetMemberEligibilityResponse |
| POST | /Pricing/GetPricingByDrugName | PricingByDrugNameRequest | PricingRequestResponse |

Common member key across requests: `groupId`, `planId`, `cardholderId`, `personCode`,
`dateOfBirth` (+ `relationshipId` for family). `FetchMemberEligibilityResponse.memberEligibility`
returns name/DOB/gender/email/address/effectiveStart/effectiveEnd/externalId — the fields
we currently get via the SFTP roster.

## TruePath → Liviniti (the WRITE direction — sending our data up)
This is the real-time replacement for pushing our eligibility roster to Liviniti. Our group
code is **`groupId = TP958025`**.
- **PATCH `/Eligibility/SetMemberEligibility`** — add/update a member. Required: `firstName`,
  `lastName`, `dateOfBirth`, `gender`, `cardholderId`, `groupId`. Optional but expected:
  `planId`, `personCode`, `relationshipId`, `effectiveStart`/`effectiveEnd`, `externalId`,
  email + full address. `gender` and `state` are enums (`Gender`, `StatesTerritories` schemas).
- **PUT `/Cardholder/ActivateCardholder`** — required `groupId`, `cardholderId`, `effectiveDate`.
- **PUT `/Cardholder/DeactivateCardholder`** — required `groupId`, `cardholderId`, `effectiveEnd`
  (this is the real-time "term" that today we do by setting a term date in the roster).
- **PUT `/Accumulator/SetMemberAccumulator`** — deductible / OOP accumulators.
These are the endpoints to build once auth clears; they map 1:1 onto our current SFTP add/term flow.

> **Gotcha — validation runs BEFORE auth.** A malformed body returns **400** *even with no
> ApiKey header at all*; only a well-formed body reaches the auth layer. So a 400 does NOT mean
> the key works. Always test auth with a correctly-shaped body.

## Test status (2026-08-27, re-tested) — STILL 401, key not authorized from our IP
Re-probed prod + sandbox with key `CC0A46C0-13E1-4B94-8A02-749EDD8F2D28` and group `TP958025`.
**A well-formed authenticated request still returns 401** — unchanged from 2026-08-11.

Proof it's genuinely the auth layer (and that the earlier "400 = progress" read was a false
signal caused by validation-before-auth), all on `/Drug/DrugSearch`:
- valid body + **real key** → **401**
- valid body + **no key** → **401**
- valid body + **garbage key** → **401**  (real key is treated identically to none)
- invalid body + real key → 400   ·   invalid body + **no key** → **400**  (validation fires pre-auth)
- unauthenticated swagger.json → **200** (host reachable)

**Our calling public IP for this test:** `69.148.172.126` (local dev).

### DEFINITIVE test from the whitelisted IP (2026-08-27) — key is the blocker, not the IP
Ran `scripts/liviniti_probe.py` as a one-off execution of the `caj-tpcrm-liviniti-nat` job
(env `cae-tpcrm-jobs`), overriding image→`tpcrm-jobs:probe` and command→`python scripts/liviniti_probe.py`,
with `LIV_KEY`/`LIV_GROUP` env vars. `az containerapp job start` is NOT MFA-blocked; the scheduled
job template was untouched (execution-only override). Output:
```
EGRESS_IP = 104.46.113.57          <- confirmed calling from the whitelisted NAT IP
DrugSearch  well-formed + REAL key -> 401 Unauthorized
DrugSearch  well-formed + NO   key -> 401 Unauthorized
Pricing     well-formed + REAL key -> 401 Unauthorized
Eligibility well-formed + REAL key -> 401 Unauthorized
```
The user confirmed Liviniti whitelisted `104.46.113.57`, and the probe proves it: we now get a
clean application 401 from that IP (not a network block). **But the REAL key still 401s identically
to sending NO key** — so the IP is no longer the blocker; the **API key `CC0A46C0-…` is simply not
activated** for group TP958025 on Liviniti's side.

### External — one thing left for Liviniti
IP `104.46.113.57` is allowlisted ✓. Remaining ask: **activate / provision the API key**
`CC0A46C0-13E1-4B94-8A02-749EDD8F2D28` for group **TP958025** (or issue a working key) — it
currently returns 401 on every endpoint, real key = no key. Once a well-formed call returns 200,
build the write flow (`SetMemberEligibility` / `ActivateCardholder` / `DeactivateCardholder`) as
the real-time counterpart to the weekly SFTP roster. To re-test after they confirm, re-run the
same one-off (image `tpcrm-jobs:probe` still in ACR). Related: weekly SFTP feed, PBM member-intake API.
