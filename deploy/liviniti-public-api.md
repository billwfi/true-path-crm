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

## Test status (2026-08-11) — key NOT yet authorized
Test key `CC0A46C0-13E1-4B94-8A02-749EDD8F2D28` returns **401 Unauthorized** on every call,
in BOTH sandbox and prod, with every header-name and key-format variant.

Diagnostics prove the mechanics are correct and it is a genuine key rejection, not our setup:
- Unauthenticated swagger.json → **200** (host reachable)
- Nonsense path + key → **404** (routing works — not an IP/gateway wall)
- GET on a POST route + key → **405** (method routing works)
- Correct route + `ApiKey` header + key → **401** (auth layer specifically rejects the key)

**Our calling public IP for this test:** `69.148.172.126`.

### Next step (external — Liviniti)
Go back to Liviniti to (a) **activate/enable** the issued key, and/or (b) **allowlist our
source IP** for it (they IP-restrict — same pattern that blocked our SFTP egress). Once a call
returns 200, we can build the real-time eligibility/claims pull. Related: the weekly SFTP feed
and the PBM member-intake API already in the CRM.
