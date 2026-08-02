# 0035: setup.mjs provisioning — team domain, covering zone, R2/D1 error mapping

- Status: accepted
- Date: 2026-08-01

## Context

`setup.mjs` (ADR 0029) provisions resources before deploying. Three provisioning bugs
surfaced during the S22 field fixes (verified live against a real Cloudflare account):

1. **Team domain never resolved.** `runSetup` read `app.access_app_id` and `app.team_domain`
   off the Access application object. Verified live list/detail responses show the app object
   has **no** `team_domain`/`access_app_id` keys (it carries `aud`, `name`, `domain`, `type`,
   …), so `finalAccessTeamDomain` was always `undefined` and provisioning threw
   "Could not determine Access team domain." The team domain actually lives on
   `GET /accounts/{accountId}/access/organizations` → `result.domain ?? result.auth_domain`
   (see the fix-round note below on the field name) — a separate endpoint that requires the
   extra **"Access: Organizations, Identity Providers, and Groups: Read"** permission;
   provisioning tokens often 403 (`[10000]`) there.
2. **Covering-zone lookup returned zero results.** `GET /zones?name=` is an **exact match**,
   so a subdomain Worker/CDN domain (`cdn.n.3a8r.com`) matched nothing and setup aborted with
   "zone not found" even though `3a8r.com` is a zone in the account.
3. **Bare HTTP statuses on R2/D1 failures.** R2 not-enabled on the account returns error code
   `10042`; a token missing the D1 permission returns code `10000` (same code as auth errors).
   The script surfaced only `Failed to list R2 buckets: <status>`, forcing the operator to
   guess.

## Decision

1. **Resolve the team domain in order:** `opts.accessTeamDomain` →
   `SETUP_ACCESS_TEAM_DOMAIN` (env, documented in `.env.example`) → the Access organizations
   endpoint (a non-OK/403/`[10000]` response **falls through**, never crashes) → interactive
   prompt "Zero Trust team domain (e.g. yourteam.cloudflareaccess.com):" → throw naming
   `SETUP_ACCESS_TEAM_DOMAIN` (headless throws deterministically via the existing
   `PROMPT_ENV_OVERRIDES` mechanism; an empty interactive answer also throws). The
   `app.access_app_id` / `app.team_domain` reads are deleted; `aud` is still taken from the
   app object (list response or detail fetch).
   - **Fix round (validator finding):** the org response is read as
     `result.domain ?? result.auth_domain`. The official API schema documents the field as
     `auth_domain` ("The unique subdomain assigned to your Zero Trust organization", example
     `test.cloudflareaccess.com`) and does NOT list `domain`; live accounts may return
     `domain` instead. Reading both makes auto-resolution work for either shape (a fresh
     account exposing only the documented `auth_domain` still resolves without prompting).
     `domain` wins when both are present.
2. **Covering-zone resolution:** new pure helper `zoneCandidates(domain)` strips the leftmost
   label iteratively (`cdn.n.3a8r.com` → `n.3a8r.com` → `3a8r.com`); `findCoveringZone`
   queries `/zones?name=` per candidate and returns the first match, logging
   `Resolved zone for <domain>: <zone.name> (<id>)`. A non-OK zone response throws via
   `describeApiError`; no matching zone returns `undefined` and `runSetup` logs the existing
   clear pre-deploy error and `return`s (no throw — consistent with ADR 0030).
   - **Fix round (validator finding, LOW):** `normalizeDomain` also strips trailing dots
     (`"example.com."` → `"example.com"`), and `zoneCandidates` skips empty/falsy candidates.
     Previously a trailing dot produced an empty-string candidate → `/zones?name=` → a strict
     API's 400 made `findCoveringZone` throw instead of the graceful not-found path. Both
     changes are defense in depth so a blank `name=` query can never reach the API.
3. **Provisioning error mapping:** new `provisioningError(response, fallback, codes)` reads
   `errors[].code` and maps `10042` → "R2 is not enabled on this Cloudflare account. Enable it
   in the Cloudflare dashboard (R2 > Overview), then re-run." and `10000` → "The Cloudflare
   API token is missing the D1 permission. Add Account → D1: Edit (see
   docs/operations/README.md 'API token scopes'), then re-run." Any other code/body falls back
   to `describeApiError` (single body read — no double-consume). Applied to the R2 bucket list
   - create and the D1 database list + create failures.

## Citations

- Access app object keys (`aud`, no `team_domain`/`access_app_id`): verified live list and
  detail responses during this fix; see
  `developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/`
  for the `aud` claim role (verified via `cfdocs`).
- Team domain on the organizations endpoint: `developers.cloudflare.com/api/resources/
zero_trust/subresources/organizations/methods/list/` — the schema documents `result.auth_domain`
  ("The unique subdomain assigned to your Zero Trust organization", example
  `test.cloudflareaccess.com`); `domain` is not in the schema but is what the human's live
  account returns, so setup.mjs reads `result.domain ?? result.auth_domain`. The endpoint
  requires the "Access: Organizations, Identity Providers, and Groups" permission (verified via
  `cfdocs`).
- `GET /zones?name=` exact match: `developers.cloudflare.com/api/resources/zones/methods/
list/` (verified via `cfdocs`).
- R2 not-enabled error code `10042`: R2 API error responses (verified via `cfdocs`).
- D1 missing-permission error code `10000`: D1 API error responses (verified via `cfdocs`).

## Consequences

- `npm run setup` now resolves the team domain automatically when the token has the
  organizations scope, prompts interactively otherwise, and fails with a copy-pasteable env
  var name in headless/CI. No more unconditional "Could not determine Access team domain."
- Subdomain Worker/CDN domains provision against their covering zone; operators get a logged
  zone name instead of a bare "zone not found".
- R2-not-enabled and D1-permission-missing now produce actionable, secret-free messages;
  other provisioning failures keep the `describeApiError` format (code + message).
- New exported helpers (`resolveTeamDomain`, `findCoveringZone`, `zoneCandidates`,
  `provisioningError`, `TEAM_DOMAIN_PROMPT`, `PROVISIONING_ERROR_MESSAGES`) and
  `accessTeamDomain` in `envToSetupOptions` are declared in `setup.d.mts` and covered by 38
  new tests (`test/setup-provisioning.test.ts`); the two existing setup test files were
  updated to the real API shape (fake `team_domain` fields removed).
- Fix round (validator findings): the org field fallback (`domain ?? auth_domain`) and the
  trailing-dot normalization/empty-candidate skip are pinned by updated validator tests
  (`test/setup-provisioning-validator.test.ts`) plus new unit/runSetup tests; full suite
  1074 tests / 38 files.
- Trade-off: the org-endpoint fallback is best-effort by design — a 403 skips it silently and
  proceeds to the prompt, so a token without the organizations scope loses automatic
  resolution but never crashes. Operators who want fully non-interactive runs set
  `SETUP_ACCESS_TEAM_DOMAIN`.
