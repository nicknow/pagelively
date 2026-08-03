# 0041: S23 — Per-page password protection: visitor gate, PBKDF2 at rest, no-store protected surface

- Status: accepted
- Date: 2026-08-02

## Context

Slice S23 promotes "per-page password / expiry / basic analytics" (spec §17) to a planned
slice, with expiry and analytics deferred. Requirements (orchestrator handoff): the admin can
set or clear one password per page (**only rule: min 5 chars; empty/absent = not protected**);
visitors get a proper server-rendered password-prompt page (never a native browser prompt);
and protected pages **bypass the CDN — served via the Worker, never via the R2 CDN custom
domain** (the exact admin-UI notice is **"All access will bypass the CDN which may increase
usage."**).

The app today has **no server secrets** (spec §12 "Secrets: None required" — Access handles
admin auth, §9) and must gain none. `setup.mjs`, `wrangler.toml`, `.env.example`, and the
`Env` surface stay untouched; `npm run types` is not needed for this feature.

Open questions OQ-19..OQ-24 (planner log) were resolved by the planner and the human; the
recommendations are **accepted as decisions** and recorded here. The credential-model options
considered: (a) stateless HMAC cookie with a new server secret; (b) password(-hash) in the
cookie re-verified per request (no secret, but PBKDF2 per page view); (c) opaque 32-byte
token in an HttpOnly cookie, SHA-256 at rest in D1, one PK lookup per protected page view.
**(c) was chosen**: it adds no secret, keeps hashing off the view path (Free-plan CPU budget,
R18), gives natural revocation (changing/clearing the password deletes the row), and needs no
provisioning changes.

All platform facts were **re-verified against current Cloudflare docs on 2026-08-02**
(citations at the bottom); **none contradicted the plan**.

> **Spec-tension note (§16 d3).** Spec §16 decision 3 — "Auth: Cloudflare Access from the
> start; **no in-app passwords**" — governs **admin authentication** (§9). This feature is
> **visitor page access** per §17 ("Per-page password / expiry / basic analytics"). These are
> different surfaces; the decisions below are not a contradiction of §16 d3, which remains
> untouched (admin still authenticates exclusively via Access).

## Decision

1. **Credential model (OQ-19 option c): opaque token cookie, SHA-256 at rest.** Unlock
   cookie `pl_unlock={pageId}.{token}`, where `token` is 32 random bytes from Web Crypto
   `crypto.getRandomValues`, base64url-encoded without padding. Attributes: `Path=/;
   HttpOnly; SameSite=Lax; Secure`. At rest, `page_unlocks` (D1) stores only `token_hash` =
   hex SHA-256 of the token; the raw token is never stored and never logged. One row per
   page (upsert — the latest unlock wins; re-unlocking rotates the token and invalidates the
   previous cookie). A protected page view costs exactly **one D1 PK lookup + one SHA-256 +
   one constant-time compare** — no PBKDF2 on the view path (R18). **No new server secret**;
   spec §12 holds; no Env/config/provisioning change.
2. **Password hashing (OQ-21): PBKDF2-HMAC-SHA256 via Web Crypto.** `hashPassword(pw)` uses
   `crypto.subtle.deriveBits` with **100,000 iterations** (default), a **random 16-byte salt
   per hash**, and a self-describing storage format
   `pbkdf2$<iter>$<salt-b64url>$<hash-b64url>` (two hashes of the same password differ).
   Rules: min **5 chars after trim**, max **256 chars** (else 400 `invalid_password` with an
   actionable message — bounds PBKDF2 input); create with empty/absent password =
   unprotected; PATCH `""`/`null` = clear; PATCH with the field absent = unchanged.
   Verification is total: malformed stored strings → `false`, never throws; derived-key
   comparison is constant-time (xor-accumulate, length-safe). The iteration count is
   **benchmarked in S23-A** under the Free-plan 10 ms CPU/request budget and the measured
   figure recorded in the Consequences below; **any future change to the count is an ADR
   amendment, never a silent tweak**.
3. **Request semantics (OQ-20).** Wrong password → **200 re-render of the prompt** with the
   inline error HTML-escaped; no 401 and no `WWW-Authenticate` — **401 stays unused** in the
   taxonomy (the existing doctrine holds; the Access gate answers 403, this surface answers
   200-with-error). Unlock POST for an unknown **or unprotected** page → **404** (no
   protection-state disclosure). Invalid id → 400 `invalid_id`. GET on the unlock route →
   the prompt for that id, or a clean 404 when the page is unknown/unprotected. Other
   methods → 405 `method_not_allowed`. Every error goes through `toErrorResponse` with
   no-store headers.
4. **Redirect (OQ-22).** A successful unlock responds **303 See Other to the canonical
   `/p/{id}/`**. No `next` parameter, no echo of any caller-controlled path — **zero
   open-redirect surface**. Visitors who arrived via a slug URL land on the id URL after
   unlock; accepted and documented (id-stable across slug renames, R22).
5. **Prompt disclosure (OQ-23).** The prompt shows only `SITE_NAME` plus the generic text
   "This page is password protected." and the form itself. **Never the page title or any
   content** (parity with the `unlisted` privacy posture — a protected page's existence is
   not broadcast). **No external resources**: no CDN/CSS/JS references; the document is
   fully inline.
6. **Public surface and routing.** Two new route families, both **public** — they must be
   reachable by visitors who are not Access-authenticated, so they dispatch **before** the
   Access-gated admin/api branch in `src/index.ts`:
   - `unlock` — `/p/{id}/unlock[/]` → `{ type: "unlock", id }`; any deeper path → `unknown`
     (clean 404). The `unlock` literal matches case-insensitively (consistent with
     `health`); the id segment stays raw (case-sensitive namespace).
   - `asset` — `/assets/pages/{id}/{rev}/{path...}` → `{ type: "asset", id, rev, path }`
     (path = remaining raw segments joined; decoded per-segment in the handler). `assets`
     was already reserved (ADR 0007) so no slug collision is possible; **any other
     `/assets/...` → `unknown`** (reserved → clean 404). `%2F` anywhere → `unknown`
     (unchanged — encoded slashes never become separators).
   - Dispatch order: `health` → trailing-slash → `home` → `slug|id` → **`unlock` | `asset`**
     → `admin|api` (Access JWT gate). `trailingSlashRedirect` does not handle the new route
     types (no 301 interference with POST unlock).
7. **Gate placement.** The gate interposes in `serveEntry` **after the D1 resolve and before
   kind dispatch**. When `page.password_hash !== null`: no valid cookie → **200 prompt page**
   (`text/html; charset=utf-8`, `no-store`, no `Cache-Tag`; the entry bytes are **not** read
   from R2); valid cookie → serve with the protected variants below. Image-kind protected
   pages are **never 301-to-CDN** — they are served as image bytes from the Worker with their
   stored content type and `no-store` (for image pages the entry URL *is* the gate).
8. **Bypass-CDN serving model.** For protected pages the injected `<base>` href is
   `new URL(request.url).origin` + `/assets/pages/{id}/{rev}/{entry_path}` — the **Worker
   origin**, never `config.assetBaseUrl`; the CDN host never appears in protected HTML
   (smoke-checked). `serveAsset` (the new Worker asset route) returns the stored object
   bytes with the stored content type and `no-store`, validating the path with the **same
   rules as the write side** (shared `validateStoredPath` extracted from `form-parser.ts`):
   decoded `..`, leading `/`, `\`, `%`, or empty segments → 400 (never sibling keys);
   invalid id → 400 `invalid_id`; non-integer/zero rev → 400 `invalid_rev` (client-supplied
   value); missing object or malformed percent-encoding → clean 404, never 500.
   `serveAsset` **does not resolve the page row and does not check the cookie** (one D1 read
   per page view, not per asset) — see the threat boundary in Consequences.
9. **`protected` cache class.** `CacheRouteClass` gains `protected` →
   `Cache-Control: no-store`, no `Cache-Tag`. Every response on the protected surface —
   prompt, unlocked entry, protected image bytes, asset bytes, unlock 303, unlock errors —
   is `no-store`. Verified platform behavior: Workers Caching does not store responses whose
   `Cache-Control` includes `private`/`no-store` (`Cf-Cache-Status: BYPASS`, Worker runs on
   every request), and a response carrying `Set-Cookie` is bypassed unless
   `private="set-cookie"` — the unlock 303 is doubly exempt (no-store + Set-Cookie) and is
   never edge-cached.
10. **Data model (migration `0002_password_protect.sql`).**
    `ALTER TABLE pages ADD COLUMN password_hash TEXT;` (nullable — existing rows become
    NULL) plus
    `CREATE TABLE page_unlocks (page_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL, FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE);`
    Auto-applied to every test DB by the existing migration runner (`readD1Migrations` +
    `applyD1Migrations`) — no config change. `PageRecord`/`NewPage` gain
    `password_hash: string | null`; `MetaPatch` gains `password_hash?: string | null`
    (undefined = unchanged, null = clear); `PagesRepository.setPasswordHash(id, hash | null)`
    (invalid id → 400 `invalid_id`; unknown id → `null`, no throw).
11. **The hash never leaves D1.** Every page JSON surface (list, detail, create 201, patch
    200) emits **`has_password: boolean` only**, through an explicit serializer
    (`toPageJson` in `admin-api.ts`). The existing `{ ...newPage, files }` (L391) and
    `{ ...updatedPage, files }` (L585) spreads are replaced with the serializer so the hash
    cannot leak (R19). Regression tests grep every response body for `password_hash` and
    `password`; the hash is never logged.
12. **Admin surface.** `ParsedPublishForm.manifest` gains `password?: string` in **both**
    parsers (multipart manifest JSON and JSON paste). Create: present + non-empty →
    validated → stored hashed; absent/empty → unprotected; invalid → 400
    `invalid_password` with an actionable message, nothing stored (validation before side
    effects, architecture 05 rule 5). PATCH: set / clear (`""`/`null`) / absent-unchanged as
    in decision 2. **Any password change (set or clear) deletes the page's unlock row** —
    existing cookies stop working immediately (re-entering the same password also forces
    re-unlock because PBKDF2 salts are random). Password set/clear **rides the existing
    mutation purge** (`ctx.cache.purge({ tags: ["page-{id}"] })`, non-fatal) — enabling
    protection evicts any previously-cached public entry (R17); after enabling, every
    response on the page is `no-store`, so nothing re-caches. Password changes do **not**
    bump `rev` (metadata edit — ADR 0006/0012). Admin UI: "Password (optional)" field on
    upload and paste; masked "Password: set" state with a replace field and a clear control
    on edit; the exact notice **"All access will bypass the CDN which may increase usage."**
    renders verbatim whenever a non-empty password is set; the hash is never echoed, even
    masked.
13. **Error taxonomy delta.** Exactly one new public code: `invalid_password` (400).
    Wrong-password is not an error (200 + inline message). `invalid_rev` is 400 when the
    value is client-supplied via the asset route (the rev.ts internal-invariant 500 case is
    unchanged). **401 remains unused.**

## Consequences

- **The view path stays cheap**: one D1 PK read + one SHA-256 + one constant-time compare per
  protected page view. PBKDF2 runs once per **unlock attempt**, never per page view. D1
  free-tier reads (5 M rows/day) are bounded in practice by the Workers request ceiling.
- **Protected traffic is Worker traffic (R24, accepted)**: every entry *and* asset request
  for a protected page is a billed Worker request — the honest cost of bypassing the CDN,
  surfaced to the admin by the verbatim notice. The Free-plan ceiling (~100 k requests/day,
  verified) is the real cap for protected pages.
- **CPU budget (R18)**: PBKDF2-HMAC-SHA256 at 100,000 iterations is expected to land in the
  low single-digit ms in workerd — comfortably inside the Free-plan 10 ms CPU/request limit
  (I/O waits do not count; isolates tolerate infrequent overruns — verified). **S23-A must
  measure and record the actual figure; if the measured cost exceeds roughly 40% of the
  budget, the iteration count is tuned down and this ADR is amended — never silently.**
- **Password changes are visible immediately via tag purge.** Purge is best-effort, so a
  failed purge could leave a stale **public** entry cached for up to the SWR window
  (1 h) — bounded, accepted (R17).
- **Threat boundary — asset bytes are URL-obscured, not individually gated.** The gate
  protects the entry document. `serveAsset` and protected image bytes at their URLs are
  served without a cookie check; anyone who obtains an asset URL (the page id is an
  unguessable nanoid, but it appears in the page URL and the base href) can fetch that
  asset directly. This matches the locked plan (OQ-19 "one PK lookup per page view"; S23-C
  AC 9 specifies no cookie check on `serveAsset`) and the OQ-24 posture: protection removes
  **references**; it cannot make bytes un-fetchable by URL. In normal browsing the browser
  sends the cookie on same-origin subrequests, so a **per-asset cookie gate is a possible
  future hardening** (cost: one D1 read per asset) — explicitly out of scope for v1.
  **Flagged to the orchestrator for confirmation.**
- **OQ-24 / R16 accepted: CDN-host exposure.** R2 public buckets serve **every** object by
  URL at the custom domain — there is no per-object/per-prefix access control at the bucket
  level (verified); restricting a bucket requires Access/WAF on the CDN domain. Protection
  therefore removes Worker-side references but **cannot revoke previously-public (or
  guessed) CDN-host URLs**; direct fetches of old CDN-host URLs remain possible. Accepted
  for this slice and recorded here and in the operator smoke checklist; re-architecture
  (separate/Access-protected R2 domain) is a documented future option, **not built now**.
- **Protected requests pay a cache-tier lookup before `BYPASS`.** Caching stays enabled on
  the single entrypoint (splitting entrypoints would break the one-entrypoint purge rule,
  ADR 0006; the docs' per-entrypoint gateway advice does not apply to a Worker that also
  serves cacheable public entries). Accepted at personal scale.
- **`Secure` cookie in local `http://` dev**: browsers will not persist the cookie in
  `wrangler dev` (http). Tests construct the `Cookie` header directly, so this is a
  dev-loop/browser caveat only; real deploys are HTTPS.
- **Bundle impact**: no new runtime dependencies — Web Crypto PBKDF2/SHA-256 and
  `getRandomValues` are natively supported (verified); the inline prompt template is small.
- **Unlock brute-force (R21)**: no rate limiting in v1 (single-operator content; admin can
  rotate/clear the password). Documented as future work.
- **Test strategy**: pure primitives (password/token/prompt/router/cache class) in the plain
  workerd pool; migration + repositories against the real migrated schema in the pool's D1
  (0002 auto-applies; FK cascade asserted; no raw token in any test DB row); gate/unlock/
  asset through the emulated pipeline with purge asserted via the recording `CacheService`
  fake (ADR 0009); JWT mocking is unaffected — unlock/asset dispatch happens **before** the
  Access branch, so public tests never need a `Cf-Access-Jwt-Assertion`. Infra seams that
  cannot be unit-tested locally (real `Cf-Cache-Status: BYPASS`, direct CDN-host fetch of a
  protected object, protected HTML containing zero CDN-host references, live prompt→unlock
  in a browser) are S23-E operator smoke-checklist items, per the established boundary.

## Scope boundaries

**In (v1):** one password per page (set/clear via create, paste, edit); server-rendered
prompt; opaque-token cookie with SHA-256 at rest; PBKDF2 storage; protected pages fully
Worker-served (entry HTML, image bytes, every referenced asset) with a Worker-origin base
href; `has_password: boolean` in all page JSON; works for every kind (`html | markdown |
bundle | image`) and for home-mode pages.

**Out (explicit):** expiry/validity windows; analytics; multiple passwords per page; change
history; per-file protection; per-visitor accounts/roles; unlock rate limiting; "remember
me"; per-asset cookie gating; **revoking direct CDN-host access to bytes that were already
public** (OQ-24/R16); any `setup.mjs`/`wrangler.toml`/`Env`/`.env.example` change.

## Platform citations (verified 2026-08-02, `cfdocs`)

- Workers Caching automatic bypass: a response with `Cache-Control: private` or `no-store`
  is not stored (`Cf-Cache-Status: BYPASS`, Worker runs on every request); a response with
  `Set-Cookie` is bypassed unless `Cache-Control` includes `private="set-cookie"` /
  `no-cache="set-cookie"`.
  <https://developers.cloudflare.com/workers/cache/configuration/> (#automatic-bypass-conditions),
  <https://developers.cloudflare.com/workers/cache/debugging/>
- R2 public buckets: expose bucket contents directly to the Internet via a custom domain
  (or rate-limited `r2.dev`); no per-object/per-prefix access control — "To restrict access
  to your custom domain's bucket, use Cloudflare's existing security products" (Access/WAF).
  <https://developers.cloudflare.com/r2/buckets/public-buckets/>
- Workers limits: **10 ms CPU per HTTP request on the Free plan** (Paid default 30 s, max
  5 min); time waiting on network I/O (D1, R2, `fetch`) does not count toward CPU time;
  isolates tolerate infrequent overruns.
  <https://developers.cloudflare.com/workers/platform/limits/>
- Web Crypto API (PBKDF2, SHA-256, `getRandomValues`) is natively supported by the Workers
  runtime. <https://developers.cloudflare.com/workers/runtime-apis/web-crypto/>

## Cross-references

- Spec: §5 (URLs & routing), §9 (Access — admin auth), §12 (secrets: none), §16 (decision 3
  — admin auth note), §17 (per-page password / expiry / analytics).
- Docs: `docs/architecture/01-system-overview.md`, `02-module-boundaries-contracts.md`,
  `03-data-model.md`, `04-caching-rev-model.md` (all updated for S23);
  `docs/operations/smoke-test-checklist.md` (S23-E additions);
  `docs/development/roadmap.md` §10 (S23 slice summary).
- ADRs: 0005 (error handling / fail-closed), 0006 (caching/rev), 0007 (reserved words),
  0008 (base injection), 0009 (cache seam), 0012 (rev bump policy), 0038 (paste API),
  0040 (base href → entry file).
- Code (implemented in S23-A..E): `src/password.ts`, `src/password-token.ts`,
  `src/password-prompt.ts`, `src/unlocks-repository.ts`, `src/unlock.ts`,
  `src/asset-serve.ts`, `src/cache-headers.ts`, `src/router.ts`, `src/entry-serve.ts`,
  `src/index.ts`, `src/pages-repository.ts`, `src/form-parser.ts`, `src/admin-api.ts`,
  `src/admin-ui.ts`, `migrations/0002_password_protect.sql`.
