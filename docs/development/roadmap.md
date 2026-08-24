# Pagelively — development history and build log

**This is a historical record, not a current task list.** Pagelively was built in small,
ordered units of work ("slices," numbered S01–S22, plus a small post-launch backlog T1–T4) by
AI agents working in defined roles; this document is the plan they worked from, kept up to
date as they went. Every item in it is **done** — there's nothing left to pick up here. It's
kept because the detailed acceptance criteria, ordering rationale, risk register, and
open-questions log are the most precise record of _why_ the implementation looks the way it
does, one level more granular than the [ADRs](../adr/) that summarize the same decisions.

If you're trying to understand current behavior, prefer `docs/architecture/` and `docs/adr/`
first — they're written for a reader who doesn't need the build-order context. Come here when
you want the exact reasoning behind one specific slice.

Source of truth for _what_ we build: `docs/product-spec.md` (§refs below point at it).

---

## 0. How this document is organized

- **Slice statuses** were tracked as `planned` → `in-progress` → `done` → `blocked` while the
  work was active. All slices S01–S22, and the post-launch backlog T1–T4 (§9), are `done`.
- **Order mattered.** Slices are numbered in the order they were built within each milestone;
  §3 records the dependency chain that drove that order.
- **Open questions (§5)** were design questions raised during planning; each was eventually
  resolved and recorded as an ADR (or as a note in this file).
- **Platform facts (§6)** were verified against Cloudflare's docs as of the date noted there.
  Cloudflare's limits and pricing change over time — treat these as a snapshot, not a live
  source; re-verify against current docs before relying on a specific number.
- Deferred/future items (spec §17) are listed in §7 and were never slices — they're ideas, not
  commitments.

---

## 1. Milestones and slice table

Status legend: `planned` (default), `in-progress`, `done`, `blocked`. Size: S/M/L.

### M1 — Pure logic, infra-light (unit-testable, no bindings)

| ID  | Slice                                   | Size | Status | Depends on             |
| --- | --------------------------------------- | ---- | ------ | ---------------------- |
| S01 | Slug & id resolution primitives         | L    | done   | —                      |
| S02 | Reserved-word validation                | S    | done   | S01                    |
| S03 | Rev handling (bump policy + key layout) | S    | done   | S01, OQ-04             |
| S04 | `<base>`-tag injection                  | S    | done   | S01, OQ-14             |
| S05 | Markdown rendering pipeline             | M    | done   | S01, S04, OQ-05, OQ-14 |
| S06 | Content-type mapping                    | S    | done   | —                      |
| S07 | Cache-header construction               | S    | done   | S01, OQ-01             |
| S08 | Trailing-slash redirects & clean 404    | S    | done   | S01                    |
| S09 | Home-mode behavior                      | S    | done   | S01, S08, OQ-08        |

### M2 — Binding integration (D1/R2/KV via local emulation)

| ID  | Slice                                                        | Size | Status | Depends on |
| --- | ------------------------------------------------------------ | ---- | ------ | ---------- |
| S10 | D1 pages repository (reads)                                  | M    | done   | S01        |
| S11 | R2 object store (key layout + metadata)                      | M    | done   | S03, S06   |
| S12 | Entry request pipeline (router + serve + 301 + 404 + health) | L    | done   | S01–S11    |
| S13 | Entry-HTML edge cache integration                            | M    | done   | S12, OQ-01 |
| S14 | KV-backed JWKS cache (optional, degrades gracefully)         | S    | done   | —          |

### M3 — Admin, upload, auth

| ID  | Slice                                                | Size | Status | Depends on               |
| --- | ---------------------------------------------------- | ---- | ------ | ------------------------ |
| S15 | Admin API: list & detail                             | M    | done   | S10, S12, S16            |
| S16 | Access JWT verification (defense-in-depth gate)      | M    | done   | S14, OQ-12               |
| S17 | Upload & publish API (multipart, manifest, kinds)    | L    | done   | S12, S16, OQ-04/05/06/11 |
| S18 | Edit & delete API (PATCH/DELETE, file ops, rev bump) | M    | done   | S17, OQ-04               |
| S19 | Admin UI (buildless dashboard/upload/edit)           | L    | done   | S17, S18                 |

### M4 — Setup & deploy (human-run; unit-tested with mocks)

| ID  | Slice                                             | Size | Status | Depends on                |
| --- | ------------------------------------------------- | ---- | ------ | ------------------------- |
| S20 | setup.mjs provisioning (idempotent, mocked tests) | L    | done   | S15–S18 surface, OQ-09/10 |
| S21 | GitHub Actions deploy workflow + quickstart docs  | S    | done   | S20                       |

### M5 — End-to-end

| ID  | Slice                                                | Size | Status | Depends on |
| --- | ---------------------------------------------------- | ---- | ------ | ---------- |
| S22 | End-to-end smoke + operator checklist + DoD closeout | L    | done   | all above  |

**Why this order:** the brief's guidance, applied — infra-light pure logic first (S01–S09
front-load maximum automated coverage with zero binding surface), then binding integration
(S10–S14, where the Workers-pool emulation is the test bed), then admin/upload/Access
(S15–S19, with the JWT gate deliberately sequenced _before_ the upload API — see note in
S16), then the human-run `setup.mjs` (S20–S21, unit-tested with mocks since it cannot be
integration-tested without an account), then end-to-end smoke (S22) plus the operator
checklist that closes the infra-seam gaps nothing local can prove.

**Security ordering note (deviation, explained):** the brief's phrase "admin/upload/Access"
is read as one milestone, but within it S16 (JWT gate) precedes S15/S17 so admin and upload
routes are never exposed — even locally — without the defense-in-depth check §9 mandates.

---

## 2. Slice acceptance criteria (concise; full drafts in `.work/planner/slices-full.md`)

Each slice's AC are concrete assertions a test can check; spec refs in parentheses.

**S01 — Slug & id resolution primitives** — `generateId()` → 8–10 URL-safe chars
`[A-Za-z0-9_-]`, unique across 10k samples (§4); `validateId` rejects empty, >64 chars and
bad charset; `slugify("My Post 1.md")` → `my-post-1` (§4), empty result → typed
`invalid_slug` failure (ADR 0007); `classifyPath` returns `home | health | slug | id |
admin | api | unknown` per §5 routing — NOTE: the architecture's `health` member
supersedes the planned `system` type (architecture 02; see also ADR 0010 for the
concrete S01 details: fixed-10 ids, 1–64 `validateId` bounds, slugify `_`/extension
rules, `%2F` → unknown). Malformed paths → `unknown`, never throw. **Done 2026-07-31**
(77 tests incl. validator edge suite; ADR 0010).

**S02 — Reserved-word validation** — `validateSlug` in `src/slug.ts` (ADR 0011): every §5
name (`p, api, admin, assets, favicon.ico, robots.txt, health, sitemap.xml`) rejected as a
slug — exact whole-segment match, case-insensitive, consumed from the single
`RESERVED_NAMES` source in `reserved.ts`; `_`-prefixed slugs rejected (incl. bare `_`);
near-misses (`admin2`, `p-2`, `my-post`, `p2`, `favicon`, `healthz`) accepted; slugs
lowercase-only (any uppercase input rejected — OQ-02 "case is moot"); bounds 1–64, charset
`[a-z0-9_-]`; a slug equal to another page's id is allowed (separate namespaces, §4).
Typed result `{ok: true} | {ok: false; error: AppError}` (`invalid_slug`, 400), never
throws. Semantics per OQ-02. NOTE (S01 validation): the edge Access application protects
`/admin*` (spec §9), so a Worker-accepted near-miss slug such as `adminx` would be
Access-challenged at the edge before the Worker classifies it — more restrictive, not a
security hole; record the path rules in the S20/S22 ops/smoke docs. NOTE (refinement):
the planner's draft `Assets` near-miss example resolves to a lowercase-rule rejection
(case is moot; the normalized `assets` is reserved — both paths reject). **In progress
2026-07-31** (25 tests incl. validator edge suite; ADR 0011).

**S03 — Rev handling** — `nextRev(1)=2`; key builder emits `pages/{id}/{rev}/{path}` (§8);
`shouldBumpRev` true only for content-affecting actions (OQ-04 default); path-escape
(`../`) rejected; unknown action type throws. **Done 2026-07-31** (49 tests incl.
validator edge suite + seeded 10k fuzz; ADR 0012).
validator edge suite; ADR 0012). NOTE (reconciliation): ADR 0006 decision 5's "slug PATCH
bumps" is amended by ADR 0012 — slug-edit does **not** bump (metadata edits are covered by
tag purge; `<base>`/template links are serve-time/relative per ADR 0008, so slug changes
yield identical entry HTML). NOTE (implemented surface, ADR 0012): `RevAction` is a closed
7-member union (`file-add | file-delete | entry-change | re-render | slug-edit | meta-edit
| create`); page deletion is handled outside `shouldBumpRev` (S18 purges + deletes objects
— no rev to bump); `nextRev`/`buildR2Key` guard rev with `Number.isInteger(rev) && rev >= 1`
→ `AppError("invalid_rev", 500)`; unknown action → `AppError("unknown_action", 500)`;
`buildR2Key` rejects escapes/absolute/empty paths as `AppError("path_traversal", 400)` and
normalizes `//`, `./`, trailing slashes, and non-escaping `..`; paths are already-decoded
strings (`%2e%2e`/`\` are literal — S17's write-side `../` rejection is the front line).

**S04 — `<base>`-tag injection** — `injectBase(html, baseHref)` (src/base-inject.ts, ADR
0013): base injected as first element inside the first real `<head>` (case/attribute
variants; tags in comments/attribute values/raw-text/template contents ignored); `<head>`
created if absent (never throws on any input — malformed/empty HTML still yields a document
containing the base); existing `<base>` removed so exactly one remains; href escaped and
normalized to strip query/fragment and preserve the caller's path; href
`{ASSET_BASE_URL}/pages/{id}/{rev}/{entry_path}` (§6). Serve-time
injection for all kinds (OQ-14 default). ADR 0008 decision 4 amended (missing `<head>`:
create, not 500).

**S05 — Markdown rendering pipeline** — `renderMarkdown(md, {allowRawHtml, showSource})`
(src/markdown.ts, ADR 0014): `# Hi` → `<h1>Hi</h1>` via `marked@^18` (sync; two isolated
`new Marked()` instances — default and escaping-`html`/`tag`-renderer — because per-call
partial `renderer` options are unsupported in v18); output wrapped in a minimal responsive
template (`<head>` base slot + charset + viewport, `main.markdown-body`, no base — OQ-14);
`showSource` appends a relative `source.md` link; raw HTML rendered iff
`ALLOW_RAW_HTML_IN_MD` true, otherwise every raw-HTML token escaped to inert text via
`escapeHtml` (ADR 0002 d4; no sanitizer — single-operator trust, R12); renderer failure →
`AppError("markdown_render_failed", 500)` (S17 surfaces as failed publish); bundle entries
that are `.md` go through the same pipeline (OQ-05). Bundle-size gate (`npm run build`)
stays green (3 MB compressed free limit, §15) — 0.70 KiB with the Phase-0 stub entry;
marked's real weight (≈13 KB gzip) lands with S17.

**S06 — Content-type mapping** — `src/content-type.ts`: `mimeTypeFor(path)` maps §6
whitelist (png/jpg/jpeg/gif/webp/svg/avif, css, js, fonts) + `.md`/`.markdown` →
`text/markdown` + `.html`/`.htm` → `text/html; charset=utf-8`; case-insensitive;
unknown/dotless → `application/octet-stream` (never throws; runtime guard for non-string
inputs added in validation); extensible `EXTENSION_TO_MIME` table; `isImageContentType`
helper for S12 image-page 301; exports `CHARSET_HTML`. **Done 2026-07-31** (60 tests; ADR 0015).

**S07 — Cache-header construction** — assets: `public, max-age=31536000, immutable`;
entry: `public, max-age=…, stale-while-revalidate=…` + `Cache-Tag: page-{id}` (values per
OQ-01); admin/API: `no-store`; never emits `s-maxage` with SWR (§11; verified semantics).
Implemented in `src/cache-headers.ts` as a pure `Headers` factory; consumed by S12/S13/S15
through the `CacheService` seam (architecture 02). **Done 2026-07-31** (32 tests; ADR 0016).

**S08 — Trailing-slash redirects & clean 404** — `/{slug}` → 301 `/{slug}/`, `/p/{id}` →
301 `/p/{id}/` (§5); root and `/health` never redirected; 404 clean HTML page for unknown
paths (§11); no redirect loops on encoded slashes.

**S09 — Home-mode behavior** — `resolveHome(homeMode, homePageSlug)` in `src/home.ts` is
pure and total (§11, OQ-08, ADR 0018). `HOME_MODE=page` + non-empty `HOME_PAGE_SLUG` that
passes `validateSlug` (S02) → `{ type: "page", slug }`; every other mode/slug combination
(including empty, null, whitespace-only, `"404"`, garbage, reserved/invalid slugs) →
`{ type: "404" }`. Direct serve at `/` (not a 301 redirect). Invalid slug errors are not
surfaced to the user. S12 handles missing-page 404s with `clean404Response` (S08).
**Done 2026-07-31** (46 unit tests + 3 validator regression tests; `src/home.ts` 100% coverage).

**S10 — D1 pages repository (reads)** — `getById`/`getBySlug`/`list` (created_at DESC, id DESC)
against the real migrated schema (§8); null on miss; `filterVisible` helper; `slugTaken`
uniqueness check with optional `exceptId`; queries stay index-covered (D1 free tier: 5 M rows
read/day). `PageRecord` uses the architecture 02 / SQL-mapped snake_case fields.
**Done 2026-07-31** (28 unit tests + 4 validator regression tests; `src/pages-repository.ts` 100% coverage).

**S11 — R2 object store** — `put`/`get`/`deletePageObjects` under `pages/{id}/{rev}/…` (§8);
bytes round-trip; `httpMetadata` carries content type + immutable Cache-Control (verified:
R2 stores and echoes it); folder paths preserved (§6); `deletePageObjects(id)` paginates;
missing object → `null`. No `Env` access; factory over injected `R2Bucket`.
**Done 2026-07-31** (29 unit tests + 7 validator regression tests; `src/object-store.ts` 100% coverage).

**S12 — Entry request pipeline** — `GET /{slug}/` and `GET /p/{id}/` serve the entry with
injected base, `text/html; charset=utf-8`, per-route Cache-Control (§5, §6, §11); markdown
serves rendered HTML; image page → 301 to `{ASSET_BASE_URL}/pages/{id}/{rev}/{entry}`;
`/health` stays public 200 (Phase 0 contract kept); unknown → 404; errors → generic 500
with `no-store`, no stack leakage. Rewires `src/index.ts` away from the Phase 0 stub.

NOTE (S04 review, 2026-07-31): the E2E browser check for this slice must assert more than the
`<base>` tag's presence — it must verify that a served entry page's RELATIVE asset references
actually resolve through the injected base (e.g. a `style.css` link or `<img src="…">` loads
from `{ASSET_BASE_URL}/pages/{id}/{rev}/…` in a real browser context). The serve-time path
(entry-serve.ts → injectBase) is what makes slug paths and id paths render identically; only
a browser-level check proves it end to end. (Currently only recorded in `.work/` scratch —
folded in here per review.)

**S13 — Entry-HTML edge cache integration** — `[cache] enabled = true` in wrangler.toml
(types regenerated); entry responses carry `Cache-Tag: page-{id}`; publish/edit purges
`{tags:["page-{id}"]}` via `ctx.cache.purge` (or `cache.purge` imported from
`cloudflare:workers` — verified API); purge is scoped to the Worker + entrypoint, which
works here because admin and entry handlers share the default entrypoint (keep it that way
— Phase 2 note); purge failure non-fatal; admin/API uncached (§11). Deploys start with a
cold cache (Worker version is part of the cache key by default — acceptable for this
workload; do not enable `cache.cross_version_cache`). If the pool can't emulate cache
HITs, live HIT verification is an operator checklist item (risk R2) — never faked.
**Done 2026-07-31** (19 cache-service tests + 6 validator regression tests; `src/cache-service.ts` 100% coverage).

**S14 — KV-backed JWKS cache** — cache Access JWKS in KV (TTL ~1 h), refetch on
miss/stale/corrupt; KV absent → fetch every time (§2, §9); write failures ignored; fetch
failure → fail closed at the gate. `JwksProvider` returns a Web Crypto `CryptoKey` for the
JWT `kid`; no `jose` dependency added.
**Done 2026-07-31** (32 tests incl. validator additions; `src/jwks-provider.ts` 100% coverage).

**S15 — Admin API: list & detail** — `GET /api/pages` → ordered JSON (title, slug, id,
kind, created_at, visibility, show_source, rev); `GET /api/pages/{id}` → page + files
list (§5, §8); unknown id → 404 JSON; invalid id → 400; unauthenticated → 403 (S16 gate
asserted end-to-end). NOTE (S03 validation, ADR 0012): call `validateId` on every id
before it reaches `buildR2Key`/the repository — an unvalidated id interpolated into an
R2 key is a latent escape (S15 and S18 share this caller discipline). **Done 2026-08-01**
(36 tests; `src/admin-api.ts`, `src/files-repository.ts`, `src/index.ts` dispatch; ADR 0025).

**S16 — Access JWT verification** — verify `Cf-Access-Jwt-Assertion` on `/admin*` and
`/api/*` (§9): signature with Web Crypto against JWKS from
`https://{ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` (verified), `aud` == `ACCESS_AUD`,
`iss` == team domain, expiry/issued-at (±60 s skew); locally generated keypairs + mock JWKS
covering **valid / expired / wrong-aud / tampered / unknown kid / missing / malformed** → all
bad cases 403, never pass-open; `email` claim extracted for the dashboard; unset `ACCESS_AUD`
→ fail closed. ADR 0024 supersedes ADR 0002's `jose` dependency; runtime deps are now only `marked`.
**Done 2026-07-31** (access-verify tests + admin-auth integration; `src/access-verify.ts` 99% coverage).

**S17 — Upload & publish API** — `POST /api/pages` multipart + manifest (§10): single
`.html` → html page; single `.md` → markdown page (render + `source.md` + `raw_md_path`);
single image → image page; bundle preserves relative paths (§6); auto-slug (S01) with
reserved (S02) and uniqueness (S10) checks → 409 on collision; ambiguous entry → 400 (OQ-11);
upload body guard ~95 MB (413; verified 100 MB Cloudflare limit); `../` paths rejected;
partial D1 failure → best-effort R2 rollback, no orphan rows; 201 + page JSON, rev = 1.
NOTE (S01 validation): trim the filename/title before `slugify` in the API layer —
`"My Post 1.md "` currently slugifies to `my-post-1-md`.
NOTES (S03 validation, ADR 0012): reject `%` in multipart filenames (literal-`%` R2 keys
are unservable); enforce the R2 key length limit (1,024 bytes; error 10020
`InvalidObjectName`); write-side `../` rejection is the enforcement front line for the
key builder's relaxed `..`-collapse normalization.
NOTE (S05 validation): strip a leading UTF-8 BOM (`\uFEFF`) from uploaded `.md` source
before passing it to `renderMarkdown`; marked treats the BOM as literal text, so `# Hi`
renders as `<p>` instead of `<h1>`.

**S18 — Edit & delete API** — slug/title/visibility/show_source PATCH with uniqueness +
reserved checks; file add/replace/delete with rev bump per OQ-04 (fresh folder, `files`
rows re-pointed, old folder left for GC per OQ-10); `DELETE /api/pages/{id}` removes rows
(cascade) + all objects (§10); entry file not deletable (served entry path protected for all
kinds, including nested bundle HTML entries and raw markdown source); every mutation purges
the page's cache tag (§11); 404 on missing page; 409/422 on conflicts. D1 failure on file
edit restores the previous page row/files rows to keep the page consistent. NOTE (S03
validation, ADR 0012): `validateId` before every `buildR2Key` call (see S15 NOTE).
**Done 2026-08-01** (admin-api-edit tests + validator/reviewer additions; coverage above
thresholds).

**S19 — Admin UI** — `GET /admin` dashboard (title, slug, id, kind, created, view/edit/
delete links); upload form (separate multi-file picker + folder picker with
`webkitdirectory`, slug, show-source, entry picker
when ambiguous) posting multipart to S17; edit form pre-filled; delete with confirm;
verified email shown (§9); "Pagelively" product name present (§10); empty state CTA;
API errors surfaced; buildless (§10, §14). Admin UI handlers load data directly from
repositories rather than making internal HTTP requests.
**Done 2026-08-01** (admin-ui tests + validator additions; 146.22 KiB / 34.74 KiB gzip bundle).

**S20 — setup.mjs** — §13 steps 1–11 with mocked Cloudflare API + mocked wrangler calls:
idempotent resource creation (list-then-create per resource; double-run creates nothing
new), Access app over `/admin*` + `/api/*` with email policy → captures `aud` + team
domain, R2 bucket → CDN domain via API + `ASSET_BASE_URL` written, wrangler.toml/overlay
updated with real IDs, `wrangler d1 migrations apply`, Zero Trust not initialized → print
steps and pause; token and interactive auth; partial-failure resume; missing zone → clear
pre-deploy error; `setup.sh`/`setup.ps1` wrappers exist (§13).
**Done 2026-08-01** (setup.mjs tests + validator findings on the Access-not-initialized
double-response-body bug and the `String.replace` `$`-pattern corruption fix; regression
tests; suite at S22 close: 976 tests / 35 files; coverage 99.69/97.26/97.83/99.91; bundle
unchanged).
**Field fix 2026-08-01** (OAuth fallback auth): interactive runs without
`CLOUDFLARE_API_TOKEN` were sending unauthenticated REST calls (`Failed to list Access apps:
400`). setup.mjs now reads the plaintext `oauth_token` stored by `wrangler login` from the
global config dir resolved as `xdgAppPaths(".wrangler").config()` — Linux
`~/.config/.wrangler/config/default.toml`, macOS `~/Library/Preferences/.wrangler/config/default.toml`,
Windows `%APPDATA%\xdg.config\.wrangler\config\default.toml` — honoring `XDG_CONFIG_HOME` on
every OS and falling back to the legacy `~/.wrangler/config/default.toml` (`WRANGLER_HOME` is
not a wrangler variable and is not honored), fails fast with actionable instructions on
`--use-keyring` (`default.enc`), and surfaces the Cloudflare `errors[].code/message` on Access
failures (distinguishing auth code `10000` from Zero Trust-not-initialized code `1047`). See
ADR 0033. +44 tests (`test/setup-auth.test.ts`); suite: 1020 tests / 36 files.

**Field fix 2026-08-01 (PENDING — approved as Option A, do not start until told).**
**wrangler OAuth cannot provision Cloudflare Access — fail fast at the Access step.**
Root cause: `GET /accounts/{accountId}/access/apps` (setup.mjs `runSetup` step 5) is rejected
with 403 `[10000] Authentication error` when authenticated via the OAuth fallback. Verified
facts: (1) Cloudflare requires at least one of `Access: Apps and Policies Read/Write/Revoke`
on the credential (cfdocs, Access applications API); (2) wrangler's OAuth app has NO `access:*`
scope — `wrangler login --scopes-list` (v4.116.0) lists 28 scopes, none Access-related, and
`--scopes` can only pick from that fixed set; (3) wrangler has no CLI command to create Access
apps (`wrangler --help`), so the REST API — and therefore a real API token — is the only path;
(4) account ID resolution is fine (`wrangler whoami`); code `10000` ≠ Zero Trust
not-initialized `1047`. Fix (test-first, `src/*` untouched, no real Cloudflare calls):

- In `buildRealDeps`/`createApiClient`, when the active auth source is the OAuth fallback (no
  `CLOUDFLARE_API_TOKEN`), `runSetup` must throw BEFORE the first Access REST call with an
  actionable message: wrangler OAuth has no `access:*` scope and the Zero Trust API rejects it
  (403 `[10000]`); create an API token with the `docs/operations/README.md` scopes (incl.
  Account → Access: Apps and Policies: Edit) and re-run with `CLOUDFLARE_API_TOKEN=…`.
  Same fail-fast pattern as the existing `default.enc`/keyring error. Env-token runs unchanged;
  a `10000` on an env token keeps the current surfacing.
- Tests in `test/setup-auth.test.ts` (and/or `test/setup.mjs.test.ts`): OAuth-only run → throws
  the Access-scope message without making the API call; env-token run → unchanged; 1047 pause
  path still works; no existing test modified.
- Docs: correct the two places claiming the OAuth path works end-to-end —
  `docs/operations/README.md` "Token vs interactive auth" and `docs/operations/
smoke-test-checklist.md` S20 "OAuth fallback path … proceeds past 'Failed to list Access
  apps' and completes" (now known-impossible; rewrite to expect the fail-fast message, and the
  interactive-success check must use `CLOUDFLARE_API_TOKEN`).
- New ADR 0034 (accepted): "wrangler OAuth cannot provision Cloudflare Access — Access step
  requires an API token", with a correction note on ADR 0033 (its interactive-success claim is
  incomplete); index ADR 0034 in `docs/adr/README.md`.
- Gates: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run
test:coverage`, `npm run build`. Commit as `fix(setup): fail fast when OAuth cannot access
Zero Trust` on a `feat/fix-setup-access-oauth`-style branch.

**Field fix 2026-08-01** (setup provisioning: team domain, covering zone, R2/D1 errors):
three provisioning bugs fixed in setup.mjs (test-first, `src/*` untouched, no real
Cloudflare calls). (1) **Team domain**: Access app objects carry `aud` but NO
`team_domain`/`access_app_id` (verified live keys); the domain lives only on
`GET /accounts/{accountId}/access/organizations` → `result.domain ?? result.auth_domain` (the
official API schema documents `auth_domain` — example `test.cloudflareaccess.com` — and not
`domain`; the human's live account returns `domain`, so setup reads both; needs the separate
"Access: Organizations, Identity Providers, and Groups" scope, which provisioning tokens
often lack — 403 `[10000]`). Resolution order: `opts.accessTeamDomain` →
`SETUP_ACCESS_TEAM_DOMAIN` → org endpoint (non-OK/403 falls through, never crashes) →
interactive prompt "Zero Trust team domain (e.g. yourteam.cloudflareaccess.com):" →
headless/empty throw naming `SETUP_ACCESS_TEAM_DOMAIN`. The old `app.access_app_id` /
`app.team_domain` reads (which always yielded undefined) are deleted. (2) **Covering zone**:
`GET /zones?name=` is an EXACT match, so `cdn.n.3a8r.com` returned zero results; the new
`findCoveringZone` strips leftmost labels (`n.3a8r.com` → `3a8r.com`) and logs the resolved
zone name; not-found still logs a clear pre-deploy error and returns (no throw, per ADR 0030).
(3) **R2/D1 error mapping**: R2 not-enabled → code `10042` gets an actionable "enable R2 in
the dashboard" message; D1 missing permission → code `10000` gets an actionable "add D1: Edit"
message; everything else keeps the `describeApiError` generic fallback. New exports
`resolveTeamDomain`, `findCoveringZone`, `zoneCandidates`, `provisioningError`,
`TEAM_DOMAIN_PROMPT`, `PROVISIONING_ERROR_MESSAGES` (+ `accessTeamDomain` in
`envToSetupOptions`); `.env.example` gains `SETUP_ACCESS_TEAM_DOMAIN`. 38 new tests
(`test/setup-provisioning.test.ts`) + updated real-shape mocks in the two existing setup test
files (fake `team_domain` fields removed). ADR 0035. README/ops docs updated (R2 enabled,
D1: Edit scope, troubleshooting entries).

- **Fix round 2026-08-01** (validator findings on the above, no src/* changes): (a)
  `resolveTeamDomain` now reads `result.domain ?? result.auth_domain` — an auth_domain-only
  org body (the documented schema shape) resolves automatically instead of silently falling
  to the prompt; `domain` wins when both are present. (b) `normalizeDomain` also strips
  trailing dots (`"example.com."` → `"example.com"`) and `zoneCandidates` skips empty
  candidates, so `/zones?name=` is never called with a blank name and a trailing-dot domain
  resolves its covering zone gracefully instead of a strict API's 400 making
  `findCoveringZone` throw. Validator-pinned tests updated to the new behavior; added
  precedence/auth_domain/trailing-dot tests. Suite now: 1074 tests / 38 files; coverage
  per-gate below.

**Field fix 2026-08-01** (R2 custom-domain attach 400 → `zoneId`, error surfacing): a real
`npm run setup` failed at step 10 with "Failed to connect R2 custom domain: 400" because the
attach body sent `zone_id` while the official API schema
(`/api/resources/r2/subresources/buckets/subresources/domains/subresources/custom/methods/
create/`) requires `zoneId` (camelCase); `domain` and `enabled` were already correct
(`enabled` optional, defaults true). Fixed test-first in `setup.mjs` (`src/*` untouched, no
real Cloudflare calls — the live failure was reproduced with mocked responses): (1) the body
now posts `zoneId`; (2) the non-409 failure path now uses `describeApiError`, so the console
shows `Failed to connect R2 custom domain (HTTP 400): [9999] …` instead of a bare status (the
old one-line message made the bug undiagnosable); 409-already-connected idempotency
unchanged. New tests in `test/setup-provisioning.test.ts` capture the actual request body and
pin its shape — `zoneId` equals the resolved covering-zone id, NO `zone_id` key (fails on the
old code), `domain` + `enabled: true` — and assert the error path carries status AND the
`errors[]` body (`[9999] something`). Verified facts recorded in ADR 0029 (assumption now
confirmed against the live API + official schema) and spec §13 step 9. Suite now: 1076 tests
/ 38 files; coverage 99.69/97.26/97.83/99.91 (threshold 85/85/80/85); bundle unchanged.

**Field fix 2026-08-01** (upload picker forced directory-only): the upload form's
`<input id="files" … multiple webkitdirectory>` and the edit page's
`<input id="add-files" … multiple webkitdirectory>` forced directory-only selection — the
user could not pick loose files at all ("it only lets me select a directory"),
because `webkitdirectory` on the same input as `multiple` makes browsers ignore loose-file
selection. Fixed test-first in `src/admin-ui.ts` (the only `src/` file changed; API contract
untouched — multipart parts are still `file:<relative-path>` + `manifest`, no changes to
form-parser/admin-api/rev/R2/D1/KV): each form now has a `multiple`-only files input
(`#files`, `#add-files`) plus a separate opt-in folder input (`#folder`, `#add-folder`) with
`webkitdirectory`; the inline JS reads the union of both inputs
(`Array.from(filesInput.files || []).concat(Array.from(folderInput.files || []))`), keeps the
`webkitRelativePath || name` fallback, registers the entry picker on both inputs' `change`
events, and shows "Choose at least one file or folder." on an empty union. Tests pin the split
in `test/admin-ui.test.ts`: `#files` and `#add-files` have `multiple` and NOT
`webkitdirectory`; `#folder` and `#add-folder` HAVE `webkitdirectory`; the inline scripts
reference both input ids, the `selectedFiles()` union helper, and the
"Choose at least one file or folder." empty-union guard (regression-pinned). Docs updated:
ADR 0028 §4, `docs/api/admin-ui.md`,
spec §10 (pickers are separate), this roadmap, `docs/operations/smoke-test-checklist.md`
(which gained an operator browser check that a deploy succeeds with both pickers in use).
Suite now: 1077 tests / 38 files; coverage 99.69/97.26/97.83/99.91 (threshold
85/85/80/85); bundle 147.42 KiB raw / 35.01 KiB gzip.

**S21 — GitHub Actions + quickstart** — manual-dispatch `deploy.yml` using repo secrets
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ADMIN_EMAILS`) running `npm ci` +
setup (§13); YAML parses; README documents Node prerequisite (Linux + Windows 10/11) and
the §13 token scopes verbatim.
**Done 2026-08-01** (headless `SETUP_*`/`ADMIN_EMAILS`/`SETUP_NON_INTERACTIVE` env overrides
in setup.mjs with exported `envToSetupOptions`/`parseTruthy`; headless determinism — no
token/emails/Zero Trust each throw, no `wrangler login`, no pause; manual-dispatch
deploy.yml wiring the three repo secrets + `SETUP_NON_INTERACTIVE: '1'`; YAML parse test via
`yaml` devDependency; README quickstart Node 22 prerequisite + §13 scopes verbatim; ADR 0030;
11 headless + 5 YAML tests added; all 38 interactive setup tests unchanged).

**S22 — End-to-end + operator checklist + DoD** — full local journey (create html page →
slug + id URLs serve with base → bundle with nested assets → markdown with show-source →
edit slug → delete, rows+objects gone); reserved slug rejected through UI → API → 4xx;
home modes exercised; `npm run build` size under the free limit; clean-devcontainer
quickstart works; deliverable `docs/operations/smoke-test-checklist.md` covering the
infra seams (R2 CDN serving + immutable headers, Worker custom domain + DNS, live Access
login → JWT verified, entry `Cf-Cache-Status: HIT`, purge-on-publish freshness, free-tier
quota verification). NOTE (S03 validation, ADR 0012): add an operator check that
traversal-ish CDN requests (`/pages/{id}/{rev}/../…`, `/%2e%2e/…`) return the bucket 404
rather than resolving to a sibling key, and that literal-`%` keys are unservable. All OQs
closed or explicitly deferred.
NOTE (S05 validation): if the Playwright MCP browser check for S12/S22 fails to launch
with a missing Chrome channel, set `PLAYWRIGHT_MCP_BROWSER=chromium` in the devcontainer
environment or install the matching browser; the app code does not depend on the channel.
**Done 2026-08-01** (`test/e2e.test.ts` — one sequential 16-step local journey: health →
fail-closed 403 → publish (kind `html`) → home modes → trailing-slash 301 → slug + id
serve with `<base>` + R2 `httpMetadata` → nested-asset bundle (kind `bundle`) → markdown
with show-source (rendered entry serves, raw `source.md` on the CDN path, Worker 404s the
raw path) → admin UI → metadata PATCH (no rev bump) → file replace (rev bump, immutability)
→ file delete → edit slug (new slug serves, old 404s clean, id serves, no rev bump) →
page delete (rows + objects gone) → reserved slug through UI → API → 4xx (upload page
carries the S19 `#upload-error` surface; `400 invalid_slug`; zero orphan rows/objects) →
home-404 mode; journey extended to the AC's full leg list 2026-08-01 (ADR 0032 — validator
gap); `test/build-size.test.ts` gate — `import.meta.glob` + `?raw` + `node:zlib.gzipSync`,
asserts < 3 MB gzip / < 64 MB raw, skips cleanly when `dist/` absent, currently
146.22 KiB / 34.74 KiB; fresh-clone quickstart re-verified (`npm ci` →
`db:local:migrate` → 959 tests at S21 state → gates → build);
`docs/operations/smoke-test-checklist.md` S22 section finalized with live checks
(custom-domain DNS, free-tier quotas re-verified 2026-08-01, traversal/`%`-key 404s) and
the pending-section markers removed; ADR 0031 records the gate design, the pool-runtime
findings (`node:fs` virtual-only — hence glob-`?raw`), and the acceptance-criteria
resolutions (no `/api/assets` route — spec §6 CDN bypass; create returns 201 + JSON, no
`Location`; single-doc upload → kind `html` not `bundle`); ADR 0032 records the journey
extension decisions; no production code changed; suite at close: 976 tests / 35 files;
coverage 99.69/97.26/97.83/99.91; bundle 146.22 KiB raw / 34.74 KiB gzip).

**Field fix 2026-08-01 — Access application path scope (live bug, no new slice):** the
Access application provisioned by `setup.mjs` was created with `domain: workerDomain` and no
path, so Access prompted on **every** public content URL (e.g. `https://n.3a8r.com/sadds-sdsd/`)
instead of only `/admin`. Fixed in `setup.mjs` only (no Worker changes — S16's fail-closed JWT
gate was already correct): the app is created with primary `domain` = `{host}/admin` and
`destinations` exactly `{host}/admin` + `{host}/api` (`destinations` supersedes the deprecated
`self_hosted_domains`; path `example.com/admin` covers `/admin` and everything under it, not
`/administrator`), and a legacy whole-domain app found by name+host is repaired **in place**
via `PUT /access/apps/{app_id}` — app id and `aud` are stable, so `ACCESS_AUD` keeps working;
`policies` is omitted from the PUT (the allow-admins policy is re-verified separately).
Acceptance pinned by 13 new/updated tests in `test/setup.mjs.test.ts` (create shape; legacy
reconcile; already-scoped no-op; whole-domain via destinations and via `domain` `/*`; PUT
failure; final `Access protects:` summary; plus 3 edge regressions added 2026-08-02 —
foreign-host app is never matched/mutated, a no-scope-info app is lenient-matched then
repaired via PUT, and scheme/case/trailing-slash variants of the correct scope normalize to
a no-op) and scoped-app responders in the provisioning/headless/auth suites. Gates:
1087 tests / 38 files; typecheck, lint, format all clean;
coverage 99.69/97.26/97.83/99.91; build dry-run ok. ADR 0029 Consequences records the fix
(including the first-match reconcile limitation);
operator checklist S20 gained the live "public URLs load with no Access prompt" regression
check. **Verified live 2026-08-02:** the user re-ran `npm run setup` (existing app reconciled
via PUT) and confirmed `https://n.3a8r.com/sadds-sdsd/` loads with **no** Access prompt while
`/admin` still prompts — merged to `main` (`1e0a09a`).

---

## 3. Dependency order and critical path

```
S01 ─┬─ S02 ─┐
     ├─ S03 ─┤
     ├─ S04 ─┤
     ├─ S05 ─┤
     ├─ S06 ─┤
     ├─ S07 ─┼─ S12 ─ S13 ─ S16 ─ S15 ─ S17 ─ S18 ─ S19 ─ S22
     ├─ S08 ─┤        │      │      └─ S14 ─┘
     └─ S09 ─┘        │      └─ S20 ─ S21 ─┘
                  S10 ─┘
                  S11 ─┘
```

- **Critical path (blocking, must be sequential):** `S01 → S12 → S13 → S16 → S15 → S17 →
S18 → S19 → S22`. S13 and S16 can swap, but S16 must precede S15/S17 (security note §1).
- **Parallelizable after S01:** S02–S09 (pure logic); S10 (needs S01); S11 (needs
  S03/S06); S14 (standalone, feeds S16); S20/S21 in parallel with S19 (setup does not
  depend on the UI).
- **Blocking on open questions:** S02←OQ-02, S03/S17/S18←OQ-04, S04/S05/S12←OQ-14,
  S07/S13←OQ-01, S17←OQ-05/06/11, S16←OQ-12, S09←OQ-08. **All resolved** (human +
  Phase-2 architect, 2026-07-31; see §5) — no slice is blocked on an open question.
- **Gate between planning and implementation:** Phase 2 architecture (ADRs for tooling,
  contracts, test strategy, error handling, caching/rev model) — human review, then
  implement slices one at a time via the per-slice loop.

---

## 4. Risk register (ranked; full detail in `.work/planner/`)

Score = likelihood × impact (H/M/L). "Verify before launch" items from the spec are
resolved in Phase 2/3 (S22 + ops checklist), never inherited silently.

| #   | Risk                                                                                                                                                                                                                                                                              | L×I | Mitigation                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Entry-cache design mismatch** — spec §11 ("Cache API + s-maxage + SWR") contradicts current platform semantics (s-maxage disables SWR; Cache API has no SWR). If implemented literally: no edge caching or wrong staleness.                                                     | M×H | OQ-01 → ADR; S07/S13 tests assert the _verified_ semantics; cite docs in the ADR.                                                                                     |
| R2  | **Infra seams can't be auto-tested** — R2-CDN serving, custom domains, live Access, real cache HITs, DNS auto-record. Local tests can't prove them.                                                                                                                               | M×H | Operator smoke-test checklist (S22, `docs/operations/`); build never fakes these (test standards #5).                                                                 |
| R3  | **Free-tier quota drift** — spec §3/§15 "verify before launch": Workers 100k req/day, D1 5 M rows read/100 k writes per day, R2 10 GB/1 M+10 M ops, KV 100 k reads/day (all verified today, subject to change).                                                                   | M×M | Dated, sourced facts in §6; Phase 2/3 re-verification task; ops checklist item; design already index-covered and cache-first.                                         |
| R4  | **D1 quota exhaustion via full-table scans** — listing queries on unindexed columns count every row read.                                                                                                                                                                         | M×M | S10: index-covered queries only (`idx_pages_slug`, PK id), `LIMIT`, admin-only listing; monitor via D1 metrics.                                                       |
| R5  | **Worker bundle size creep** — 3 MB compressed free limit (verified); `marked` + admin HTML + code must fit.                                                                                                                                                                      | M×M | `npm run build` (dry-run, prints size) is a gate from S05 onward; buildless admin (§10); lean deps.                                                                   |
| R6  | **Upload pipeline memory/limit** — 100 MB body (verified), 128 MB Worker memory; `formData()` buffers the whole body.                                                                                                                                                             | M×M | Pre-buffer size guard (413, S17); ops guidance "resize before upload" (§15); multipart R2 = future (§17).                                                             |
| R7  | **Slug/id collisions or reserved-name escapes** → user-visible 404s or shadowed routes.                                                                                                                                                                                           | M×M | S01/S02 exhaustive table tests; id uniqueness by construction; slug conflict → deterministic `-2` suffix; collision → 409.                                            |
| R8  | **setup.mjs partial failure / non-idempotent runs** → duplicate resources or half-provisioned state (worst case: broken Access or CDN config).                                                                                                                                    | M×M | S20: mocked double-run idempotency tests; list-then-create; Zero-Trust pause path; operator checklist; deployer agent runs it with human approval.                    |
| R9  | **Access JWT verification bugs** (crypto, JWKS fetch, clock skew, key rotation) → locked-out admin or pass-open API.                                                                                                                                                              | M×M | S16: mock-JWKS matrix (valid/expired/wrong-aud/tampered/unknown-kid/missing/malformed); fail-closed defaults; KV TTL bounds staleness; smoke checklist.               |
| R10 | **Rev-folder storage growth** — every rev duplicates objects; R2 free = 10 GB; no GC in v1 (OQ-10).                                                                                                                                                                               | L×M | Documented GC deferral; manual cleanup note in ops docs; realistic personal-use math.                                                                                 |
| R11 | **Windows compatibility of setup** — spec promises Linux + Windows 10/11 (§13); wrangler subprocess quirks.                                                                                                                                                                       | L×M | Pure-Node script (no shell); mocked-process tests; wrapper scripts; human checklist on Windows.                                                                       |
| R12 | **Markdown raw-HTML trust model** — `ALLOW_RAW_HTML_IN_MD` defaults to allow (§7); content is single-operator, but an XSS slip leaks cookies/session.                                                                                                                             | L×M | Trust model documented; flag tested both ways (S05); no secrets in the app by design (Access handles auth, §9).                                                       |
| R13 | **Tooling drift** — vitest-pool-workers / wrangler / marked versions move; local emulation vs prod parity shifts.                                                                                                                                                                 | L×M | Pinned devDependencies (package.json), ADR on tooling, `cfdocs` re-verification on upgrades.                                                                          |
| R14 | **Acceptance drift** — implementer/validator drift from spec over 22 slices.                                                                                                                                                                                                      | L×M | AC map to spec §refs (this file); validator checks behavior vs spec, not just tests; per-slice human review gates.                                                    |
| R15 | **Workers Caching not emulated by the pool** — `cache.enabled` read-through HIT behavior may be untestable locally. (`cache.purge` itself is a documented runtime API — importable from `cloudflare:workers` — so purge tests should work; HIT emulation is the unverified part.) | M×L | Phase 2 architect spike: check Miniflare HIT emulation in week one; S13 asserts the contract (headers/tags/purge via adapter) regardless; checklist covers live HITs. |

---

## 5. Open-questions log

Full options/analysis: `.work/planner/open-questions-detail.md`. Decision needed from the
**human** (user-visible/scope/security) or the **Phase 2 architect** (contracts/ADRs).
Blocking = a slice's AC cannot be finalized without it.

**Resolved 2026-07-30 (human-approved):** OQ-01, OQ-02, OQ-04, OQ-14 — the recommendations in
the table below are locked as the v1 defaults; Phase 2 formalizes them as ADRs.

**Resolved 2026-07-31 (Phase-2 architect, ADRs 0002–0009 / architecture docs):** OQ-03
(ADR 0007 — slugify + `-2` suffix), OQ-05 (one Markdown code path; kind stays `bundle`),
OQ-11 (server 400 + UI entry picker), OQ-12 (bare domain stored; `https://` prepended).

**Resolved 2026-07-31 (human-approved, Phase 2 review):** OQ-06 (PDF allowed as `bundle`

- 301-to-CDN serving), OQ-07 (accept R2's own 404 in v1), OQ-08 (home `page` mode serves
  directly at `/`), OQ-09 (no v1 `PUBLIC_LISTING` behavior), OQ-10 (no rev GC in v1), OQ-13
  (defer re-render-all per §17). All 14 open questions are now closed; the roadmap is final
  until implementation reveals new findings.

**Closed at S22 closeout (2026-08-01):** S22 validation (ADR 0031) surfaced three
acceptance-criteria wording gaps — no `/api/assets` route (spec §6 CDN bypass; reserved-slug
rejection lives in the admin API + UI surfacing), create returns 201 + JSON with no
`Location` (spec §5), single-document uploads are kind `html` not `bundle` (ADR 0026) — none
of which requires a new open question or a spec change. The operator checklist
(`docs/operations/smoke-test-checklist.md`) is the S22 deliverable; free-tier quotas in §6
re-verified 2026-08-01.

**Resolved 2026-08-02 (T1 slice, ADR 0036):** OQ-15 — implemented as recommended: user-entered
slugs are cleaned (trim, lowercase, disallowed runs → `-`, truncate to 64) and the cleaned slug
is echoed to the UI; only empty/reserved-after-cleaning (or structurally invalid) slugs are
rejected, with an actionable `message` on every error response (`{ error, message }`). 26 new
tests (incl. validator fix: all six UI error-display sites prefer the message); suite at 1113.

**Resolved 2026-08-02 (T2 slice, corrected scope):** OQ-16 — the entry package (`index.html` +
`source.md` for Markdown pages) stays protected and cannot be deleted individually; the whole page
must be deleted via the Delete page button. The server-side `entry_not_deletable` message was
improved and the UI now suppresses the per-file Delete button for entry files with a hint.

**Resolved 2026-08-02 (T4 slice, ADR 0038):** OQ-17 — `POST /api/pages` accepts `Content-Type:
application/json` with `{ content, format: "html"|"markdown", slug?, title?, visibility?,
showSource? }` (create-only; replace-on-edit is a follow-up). The JSON path feeds a synthetic file
into the existing create pipeline so Markdown pastes render through the same `source.md` +
`index.html` path as a multipart `.md` upload. A 1 MB (`1_000_000` byte) content guard returns
`413 content_too_large` before any storage. The admin UI has a "Paste content" tab with format
radio (Markdown default) and a shared error box. 34 new tests (13 API, 16 form-parser, 5 UI);
suite at 1153/39.

**Resolved 2026-08-02 (T3 slice, ADR 0039):** OQ-18 — Option A: buildless overhaul. The admin UI
stays inline in `src/admin-ui.ts` with no new dependencies, no external CDN, and no build step.
A design-token CSS system (light theme), responsive card/table layout, visually distinct tabs,
inline slug preview, non-blocking toast notifications, and protected-file badges were added.
Delete confirmations remain `confirm()` dialogs, but API errors are surfaced via toasts instead of
blocking `alert()` calls. The dashboard now shows page kind and visibility badges and a clearer
empty state. 9 new UI regression tests, plus updates to existing UI tests; suite at 1162/39;
build size 168.74 KiB raw / 39.11 KiB gzip.

| ID    | Question                                                                                                                      | Spec     | Recommendation                                                                                                                                                                                           | Decider           | Blocks           | Status             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ---------------- | ------------------ |
| OQ-01 | Entry-cache design: §11's "Cache API + s-maxage + SWR" contradicts current docs (s-maxage disables SWR; no SWR in Cache API). | §11      | Workers Caching (`cache.enabled`) + `public, max-age=300, stale-while-revalidate=3600` + `Cache-Tag: page-{id}` + `ctx.cache.purge({tags})` on publish (verified API).                                   | Human + architect | S07, S13         | decided            |
| OQ-02 | Reserved-word semantics: which §5 entries are exact-match vs prefix?                                                          | §5       | Exact-match for all names; `_` is the only prefix rule; slugs lowercase-only.                                                                                                                            | Human             | S02              | decided            |
| OQ-03 | Slug auto-generation algorithm + collision handling.                                                                          | §4       | slugify (lowercase, `-` for non-alnum); collisions get deterministic `-2`/`-3`; fallback to id-prefix.                                                                                                   | Architect         | —                | decided (ADR 0007) |
| OQ-04 | Which admin actions bump `rev`.                                                                                               | §8, §11  | Content-affecting only (file/entry changes, re-render); metadata edits don't bump — cache purge covers them.                                                                                             | Architect + human | S03, S17, S18    | decided            |
| OQ-05 | Bundle with `.md` entry: render through §7 pipeline?                                                                          | §4, §7   | Yes — one Markdown code path; kind stays `bundle`.                                                                                                                                                       | Architect         | S05, S17         | decided            |
| OQ-06 | Non-image single raw file (PDF): new kind or reject?                                                                          | §4, §6   | Allow as `bundle` with 301-to-CDN serving ("raw-file pages" hint).                                                                                                                                       | Human             | S17              | decided            |
| OQ-07 | Clean 404 for assets: CDN host has no Worker; R2 returns its own 404.                                                         | §11      | Accept R2's default 404 in v1; clean page covers Worker-host misses only.                                                                                                                                | Human             | —                | decided            |
| OQ-08 | `HOME_MODE=page`: serve at `/` or redirect?                                                                                   | §11      | Serve directly (spec-literal); `/{slug}/` stays canonical.                                                                                                                                               | Human             | S09              | decided            |
| OQ-09 | `PUBLIC_LISTING` var (§12) vs deferred listing (§16).                                                                         | §12, §16 | Keep placeholder var, no v1 behavior; documented deferred.                                                                                                                                               | Human             | —                | decided            |
| OQ-10 | Rev GC "after a grace period" — no mechanism specified.                                                                       | §8       | No GC in v1; ops note + manual cleanup; future automation.                                                                                                                                               | Human             | —                | decided            |
| OQ-11 | Entry detection when manifest absent/ambiguous.                                                                               | §10      | Server 400 with clear message; UI forces entry picker when ambiguous.                                                                                                                                    | Architect         | S17              | decided            |
| OQ-12 | `ACCESS_TEAM_DOMAIN` bare domain vs URL.                                                                                      | §9, §12  | Store bare; code prepends `https://`; strip scheme defensively.                                                                                                                                          | Architect         | S16              | decided            |
| OQ-13 | "Re-render all Markdown" (§7) vs deferred (§17).                                                                              | §7, §17  | Defer per §17; roadmap records it.                                                                                                                                                                       | Human             | —                | decided            |
| OQ-14 | Base tag: bake into markdown template (§7) vs serve-time injection (§6).                                                      | §6, §7   | Uniform serve-time injection; template links stay relative; no stale-rev risk; no rev bump on show_source toggle.                                                                                        | Architect + human | S04, S05, S12    | decided            |
| OQ-15 | User-entered slug on create/edit: clean instead of reject?                                                                    | §4, §12  | Clean where fixable (trim, lowercase, disallowed runs → `-`, truncate to 64) and echo the cleaned slug; reject only empty/reserved-after-cleaning with an actionable message (T1).                       | Architect + human | T1 (S02/S17/S18) | decided (ADR 0036) |
| OQ-16 | Deleting `source.md` from a Markdown page: what happens to `kind`/`raw_md_path`/`show_source`?                                | §8, §12  | Corrected during T2: the entry package (`index.html` + `source.md`) is protected; to delete a page, use the Delete page button. `raw_md_path` stays non-null for Markdown pages.                         | Human             | T2 (S18)         | decided            |
| OQ-17 | Paste-content API shape: JSON body vs multipart `content` field; create-only vs also replace-on-edit.                         | §10      | `POST /api/pages` accepts `application/json` `{ content, format: html\|markdown, … }` (create-only first; replace-on-edit is a follow-up) — one endpoint, no multipart overhead for text (T4, ADR 0038). | Architect         | T4 (S17)         | decided (ADR 0038) |
| OQ-18 | Admin UI modernization: framework vs buildless.                                                                               | §15      | Buildless overhaul (design tokens, modern responsive layout, toasts, inline feedback) — zero new deps, stays within Workers free limit; framework/SPA documented deferred (T3).                          | Human             | T3 (S19)         | decided (ADR 0039) |

---

## 6. Verified platform facts (2026-07-30, `cfdocs`)

Used by the plan; re-verify before depending on them at build time. Spec's "verify before
launch" items are resolved here or flagged in the risk register — not inherited.

- Workers Free: **100,000 requests/day** (Error 1027 beyond); Paid: no limit.
  https://developers.cloudflare.com/workers/platform/limits/
- Request body limit is per Cloudflare plan: **Free/Pro 100 MB** (413 beyond); Business
  200 MB; Enterprise 500 MB. Spec's "~100 MB" holds.
  https://developers.cloudflare.com/workers/platform/limits/
- Worker size: **3 MB compressed (Free)** / 10 MB (Paid); 64 MB uncompressed.
  https://developers.cloudflare.com/workers/platform/limits/
- R2 free: **10 GB-month, 1 M Class A + 10 M Class B ops/month, egress free**.
  https://developers.cloudflare.com/workers/platform/pricing/
- D1 free: **5 M rows read/day, 100 k rows written/day, 5 GB storage**.
  https://developers.cloudflare.com/workers/platform/pricing/
- KV free: **100 k reads/day, 1 k writes/day, 1 k deletes/day, 1 GB**.
  https://developers.cloudflare.com/workers/platform/pricing/
- Access JWT: `Cf-Access-Jwt-Assertion` header; JWKS at
  `https://{team-domain}/cdn-cgi/access/certs`; verify sig + `aud` + `iss` (RS256).
  https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/
- Workers Caching: `[cache] enabled = true`; `Cache-Control: public, max-age=N,
stale-while-revalidate=M`; **s-maxage/must-revalidate disable SWR**; **Cache API has no
  SWR** (and Cache API is unavailable for Access-fronted Workers — we use Workers Caching,
  not Cache API, and entry paths are public anyway). Purge: `ctx.cache.purge({tags})` or
  `cache.purge` imported from `cloudflare:workers`; scoped to the owning Worker **and the
  calling entrypoint**; no zone-level purge affects Workers Caching; no purge-by-host
  (host is not part of the cache key). Cache key = path + entrypoint + (by default) Worker
  version → every deploy starts cold; `cache.cross_version_cache` opt-in. Never cached:
  520–526, 206. At launch, cached responses are subject to the Free-plan size limit on all
  accounts (temporary). Purge rate limits = zone purge API limits.
  https://developers.cloudflare.com/workers/cache/ ,
  https://developers.cloudflare.com/workers/cache/purge/ ,
  https://developers.cloudflare.com/workers/cache/limitations/ ,
  https://developers.cloudflare.com/cache/concepts/cache-control/
- Worker custom domains: `[[routes]] pattern = "…" custom_domain = true`; requires active
  zone in same account; auto-creates DNS on deploy; no existing CNAME on the hostname.
  https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- R2 public buckets: custom domain requires same-account zone; r2.dev is rate-limited
  dev-only; no root listing; default CDN cache covers only default extensions (a "Cache
  Everything" rule may be needed for non-default asset types — operator checklist item).
  https://developers.cloudflare.com/r2/buckets/public-buckets/
- R2 object metadata: `httpMetadata` (incl. `cacheControl`) stored at upload and echoed on
  public serving → immutable asset headers work without a Worker.
  https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
- Access API: `GET/POST /accounts/{account_id}/access/apps` (+ `PUT …/apps/{app_id}` update);
  permission "Access: Apps and Policies Write"; app `aud` captured for `ACCESS_AUD`. The
  application body's `domain` is "the primary hostname and path secured by Access", and
  `destinations` (`PublicDestination` uri, path-capable) supersedes the deprecated
  `self_hosted_domains` field — verified 2026-08-01 via the create/update API references.
  `example.com/admin` covers `/admin` and everything under it (not `/administrator`);
  a pathless `example.com` covers the whole domain (the bug this field fix repairs).
  https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/ ,
  https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/update/ ,
  https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/ ,
  https://developers.cloudflare.com/cloudflare-one/access-controls/applications/linked-app-token/
- Local D1 migrations + Workers-pool test emulation: Phase 0 ADR 0001 (verified then;
  re-verify on upgrades). https://developers.cloudflare.com/workers/testing/vitest-integration/

---

## 7. Explicitly deferred (spec §16/§17 — not slices)

Zip upload (needs `fflate`), public listing at `/`, "re-render all Markdown" (OQ-13),
root-relative link rewriting, multipart R2 uploads for large media, per-page
expiry/analytics, optional SPA admin, rev GC automation (OQ-10), theme selection.
They belong in the open-questions log / future list, never silently in code (brief
boundaries).

> **Per‑page password protection** was also listed here but has since been **built** as slice
> S23. See §10 for the full slice table, open-questions log, and risk register. Password
> protection was promoted from §17 to a planned slice on 2026-08-02 (OQ-19..OQ-24) and is now
> complete. Expiry and analytics remain deferred.

---

## 8. Phase-2 handoff notes (for @architect)

> **Phase-2 status (2026-07-31): complete.** All handoff items are resolved:
> cache model + TTLs (ADR 0006), rev policy (ADR 0006), base injection placement (ADR 0008),
> slug rules (ADR 0007), coverage threshold (ADR 0003 + `docs/architecture/08` — 85/85/85/80),
> module boundaries (`docs/architecture/02`), `marked` pin + Workers compatibility
> (ADR 0002 + `docs/architecture/07`), JWKS verification module shape
> (`docs/architecture/02`, S14/S16), Miniflare/Workers-Caching emulation (spike +
> ADR 0009 — not emulated; contract seam + operator checklist), and **the single-entrypoint
> rule is kept as a hard constraint** (`ctx.cache.purge` is entrypoint-scoped; documented in
> architecture 01/04). Platform facts re-verified against current docs before the ADRs were
> locked — no corrections to §6 were needed.

Decide via ADR before the blocking slices start: OQ-01 (cache model + TTLs), OQ-04 (rev
policy), OQ-14 (base injection placement), OQ-02/03 (slug rules). Also: final coverage
threshold (placeholder 80% today), module boundaries for the pure-logic units, the
`marked` pin + Workers compatibility, the JWKS verification module shape, whether
Miniflare emulates Workers Caching HITs (S13 test strategy, risk R15), and **keep admin
and entry handlers on the same Worker entrypoint** — `ctx.cache.purge` is entrypoint-scoped,
and splitting entrypoints would break purge-on-publish unless reworked. Re-verify every
platform fact in §6 against current docs before locking an ADR that depends on it.

---

## 9. Post-S22 task backlog (2026-08-02, user-requested)

Small user-requested field tasks, planned and executed in dependency order
**T1 → T2 → T4 → T3** (independent/self-contained first; the admin-UI overhaul
last so it restyles the new surfaces in one pass). Each is a normal
test-first slice with the standard gates; the three OQ rows above (OQ-15..OQ-18)
are resolved during planning, human-approved for the user-visible ones.

| ID  | Task                                                                                                                                                                                                                                                                        | State | Why this order                                                                                                                               | Dependencies |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| T1  | **Slug feedback + auto-clean** — `invalid_slug` should be rare: clean user-entered slugs (trim, lowercase, disallowed runs → `-`, length truncate) before rejecting; reject only empty/reserved-after-cleaning with an actionable message; echo the cleaned slug to the UI. | done  | Smallest, self-contained, pure logic + one API surface; de-risks the shared `slug.ts` before other tasks touch it.                           | OQ-15        |
| T2  | **Protect entry package and clarify whole-page deletion** — entry files (`index.html`/`source.md`) cannot be deleted individually; improve the API error message and add a UI hint; the whole page is deleted via the Delete page button.                                   | done  | Corrected scope: server protection already rejects individual entry deletion; this slice makes the failure actionable and the UI consistent. | OQ-16        |
| T4  | **Paste HTML/Markdown** — publish API accepts pasted text (create-only first) instead of a file; Markdown goes through the same render pipeline (`source.md` + `index.html`).                                                                                               | done  | New API surface; the UI overhaul (T3) will style it in one pass.                                                                             | OQ-17        |
| T3  | **Admin UI modernization** — buildless overhaul with a design-token-based CSS system, responsive layout, tabbed upload/paste, toast notifications, inline slug preview, and protected-file badges; framework/SPA deferred.                                                  | done  | Last: restyles the surfaces T1/T2/T4 introduce in a single pass instead of twice.                                                            | OQ-18        |

---

## 10. S23 — Per-page password protection (ADR 0041, ADR 0042, ADR 0043)

Slice S23 promotes "per-page password / expiry / basic analytics" (spec §17) to a planned slice,
with expiry and analytics still deferred. The full planning context (open questions OQ-19..OQ-24,
risk register R16..R24, the password-protect-plan.md document) is in `.work/planner/`; the
locked design decisions are in `docs/adr/0041-s23-password-protected-pages.md`. Implementation
details for S23-A (primitives) are in ADR 0042; for S23-B (schema + repositories) in ADR 0043.

### Slice table

| ID    | Slice                                                                                                            | Size | Status | Depends on           |
| ----- | ---------------------------------------------------------------------------------------------------------------- | ---- | ------ | -------------------- |
| S23-A | Password/token primitives, prompt page, unlock/asset routes, protected cache class (pure, no bindings)           | M    | built  | S03, S07, S08        |
| S23-B | Migration 0002, password_hash column, unlocks repository (D1 emulation)                                          | M    | built  | S23-A, S10           |
| S23-C | Public gate: prompt serving, unlock POST/Cookie, protected entry and image, asset-serving route (emulated D1/R2) | L    | built  | S23-B, S12           |
| S23-D | Admin API + UI: password on create/patch, `has_password` JSON, forms, CDN-bypass notice                          | M    | built  | S23-C, S17, S18, S19 |
| S23-E | Docs, smoke tests, e2e journey, closeout                                                                         | S    | built  | S23-D                |

### Open-questions log (OQ-19..OQ-24)

| ID    | Question                                                                     | Status                |
| ----- | ---------------------------------------------------------------------------- | --------------------- |
| OQ-19 | **Unlock credential model:** opaque-token cookie, SHA-256 at rest (option c) | **closed** — ADR 0041 |
| OQ-20 | Wrong-password semantics: 200 + inline error; unprotected → 404              | **closed** — ADR 0041 |
| OQ-21 | Password rules: min 5/max 256; PBKDF2 @ 10,000 iterations                    | **closed** — ADR 0041 |
| OQ-22 | Redirect after unlock: canonical `/p/{id}/`                                  | **closed** — ADR 0041 |
| OQ-23 | Prompt disclosure: site name only, never page title                          | **closed** — ADR 0041 |
| OQ-24 | CDN-host exposure acceptance: documented limitation                          | **closed** — ADR 0041 |

### Risk register (R16..R24)

| #   | Risk                                                                        | L×I | Status                                                                       |
| --- | --------------------------------------------------------------------------- | --- | ---------------------------------------------------------------------------- |
| R16 | CDN-host direct byte exposure — R2 public bucket serves every object by URL | M×H | **accepted** — documented in ADR 0041                                        |
| R17 | Stale public cache after enabling protection                                | M×M | **mitigated** — PATCH purges tag; protected = no-store                       |
| R18 | PBKDF2 CPU cost on Free plan                                                | M×M | **mitigated** — 10k iterations (~4 ms); benchmarked                          |
| R19 | Hash leakage via API JSON                                                   | M×H | **mitigated** — explicit serializer, regression tests                        |
| R20 | Cookie forgery / tampering                                                  | M×M | **mitigated** — 32-byte random token; SHA-256 at rest; constant-time compare |
| R21 | Unlock brute-force — no rate limiting in scope                              | L×M | **accepted** — documented future work                                        |
| R22 | Slug rename while unlocked — cookie is id-based                             | L×L | **accepted** — id is stable across renames                                   |
| R23 | Asset-route traversal / encoding bugs                                       | L×M | **mitigated** — path validation with write-side rules                        |
| R24 | Worker usage increase for protected pages                                   | L×M | **accepted** — verbatim admin notice; ADR 0041                               |

### Known limitations

- **CDN-host exposure (R16 / OQ-24):** R2 public buckets serve every object by URL at the custom
  domain. Protection removes Worker-side references but cannot revoke previously-public (or
  guessed) CDN-host URLs. Future option: Access-protected/separate R2 domain — not built here.
- **No unlock rate limiting (R21):** the public `/p/{id}/unlock` endpoint accepts guesses.
  Single-operator content means the admin can rotate/clear the password if needed.
- **No cookie expiry / "remember me":** the unlock cookie is a session cookie (no `Max-Age`).
  Re-authentication is required on browser restart.
- **No per-asset cookie gating:** `serveAsset` does not check the cookie (one D1 PK lookup per
  entry view, not per asset). Asset URLs are obscured by the unguessable page id but are not
  individually gated.

### Test count impact

The full S23 suite adds approximately 395 tests across slices A through E, for a final suite at
closeout of **1482 tests across 49 files** (from 1087 tests / 38 files at S22 close). Coverage
remains above the 85/85/80/85 threshold at 99.39/97.23/98.19/99.68 (statements/branches/functions/lines).
Bundle size: **190.21 KiB raw / 44.17 KiB gzip** (from 168.74 KiB raw / 39.11 KiB gzip at T3
close). The increase reflects the inline prompt template, unlock handler, asset-serving logic,
and data-model additions — no new runtime dependencies were added.

---

## 11. T5–T6: Better Markdown rendering + save confirmation toast (2026-08-06)

### Slice table

| ID   | Slice                                                                             | Size | Status  | Depends on |
| ---- | --------------------------------------------------------------------------------- | ---- | ------- | ---------- |
| T5-A | Template system module + default template CSS (typography, dark mode, responsive) | M    | built   | —          |
| T5-B | Wire template into `renderMarkdown` pipeline, update tests                        | M    | planned | T5-A       |
| T6   | Save confirmation toast on metadata PATCH success in edit form                    | S    | planned | —          |

**Order: T5-A → T5-B → T6** (T5-A/B are architectural; T6 is independent and could be done in
parallel but is sequenced after for simplicity).

### Dependency graph

```
T5-A (template module + CSS)
   └── T5-B (wire into renderMarkdown)

T6 (save toast) — independent
```

### Acceptance criteria (abbreviated; full detail in `.work/planner/work-item-plan.md`)

**T5-A:**

- `src/templates/default.ts` exports `renderDefaultTemplate(content)` and `DEFAULT_TEMPLATE_CSS`
- Default template outputs a valid HTML doc with inline `<style>` containing rich CSS
- CSS covers: typography (headings, paragraphs, code, links, lists), responsive images, tables,
  blockquotes, `.source-link` styling, dark mode via `@media (prefers-color-scheme: dark)`
- CSS uses custom properties; no external resources; no `<base>` tag
- No `<base>` in the template (OQ-14 contract preserved)

**T5-B:**

- `MarkdownRenderOptions` gains `template?: string` (default `"default"`)
- `renderMarkdown()` uses the template system; unknown template names fall back to `"default"`
- All existing markdown tests updated for the new template output (byte-for-byte pin updated)
- `showSource` and `allowRawHtml` still work; `injectBase` composition still produces one base
- Bundle size gate stays green

**T6:**

- Edit form PATCH 200 success: `showToast('Page updated.', 'success')` before delayed reload
- Reload deferred by 1.5 s (`setTimeout`)
- Error path unchanged (error box only, no toast)
- Existing admin UI tests pass; new tests pin the `showToast` and `setTimeout` calls in the JS

### Risk register additions

| #   | Risk                                                    | L×I | Mitigation                                                                 |
| --- | ------------------------------------------------------- | --- | -------------------------------------------------------------------------- |
| R25 | **Bundle size from inline CSS** (~3–5 KB raw)           | M×M | `npm run build` gate; current 44 KiB gzip vs 3 MB free limit.              |
| R26 | **CSS stripped/mangled** by marked or replacement logic | L×M | CSS is in `<head>`, `marked` never touches; tests pin exact CSS.           |
| R27 | **Browser compatibility** of advanced CSS features      | L×L | Stick to well-supported features; `prefers-color-scheme` widely supported. |
| R28 | **User interaction during toast delay**                 | L×L | 1.5 s delay is short; no functional harm.                                  |
| R29 | **Double-submit race** on edit form                     | L×M | Out of current slice scope; existing behavior unchanged.                   |

### Open questions

| ID    | Question                                             | Options                                                      | Recommendation                        | Decider   | Blocks | Status             |
| ----- | ---------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------- | --------- | ------ | ------------------ |
| OQ-25 | Template selection storage for future multi-template | (a) New `template` column, (b) hardcoded, (c) page JSON only | **(c)** hardcoded `"default"` for now | architect | T5     | open → recommended |
| OQ-26 | Unknown template name at render time                 | (a) Throw, (b) minimal fallback, (c) default fallback        | **(c)** default fallback              | architect | T5     | open → recommended |

---

## 12. S24 — Raw markdown hosting (2026-08-24)

Operator request: host raw markdown without HTML conversion — visiting a raw page (slug or id
URL) serves the raw markdown only as text. The full planning context (design summary, slice
plan, open questions OQ-27..OQ-33 with human-approved recommendations) is in
`.work/planner/raw-md-{slice-plan,open-questions}.md`; all locked decisions are recorded in
`docs/adr/0054-raw-markdown-hosting.md`.

### Slice table

| ID    | Slice                                                                  | Size | Status | Depends on         |
| ----- | ---------------------------------------------------------------------- | ---- | ------ | ------------------ |
| S24-A | Model: extend `PageKind` with `"raw-markdown"` (repos + API union)     | S    | built  | OQ-27              |
| S24-B | Publish/edit API: raw upload + paste + file-replace semantics          | M    | built  | S24-A, OQ-29/31/32 |
| S24-C | Public serving: entry 301 (public) / Worker bytes no-store (protected) | M    | built  | S24-B, OQ-28/29    |
| S24-D | Admin UI (kind option, badge, edit-page suppression), docs, closeout   | S    | built  | S24-C, OQ-29/33    |

### Open-questions log (OQ-27..OQ-33)

| ID    | Question                                                                  | Status                |
| ----- | ------------------------------------------------------------------------- | --------------------- |
| OQ-27 | New `PageKind` `"raw-markdown"` vs per-page render flag                   | **closed** — ADR 0054 |
| OQ-28 | Entry normalized to `source.md` vs original filename                      | **closed** — ADR 0054 |
| OQ-29 | Public entry → 301 to CDN object vs Worker-streamed bytes                 | **closed** — ADR 0054 |
| OQ-30 | Object content type `text/plain; charset=utf-8` (inline display)          | **closed** — ADR 0054 |
| OQ-31 | Per-object content-type override; global `.md` mapping untouched          | **closed** — ADR 0054 |
| OQ-32 | `manifest.kind` surface; post-create mode toggle **rejected** by operator | **closed** — ADR 0054 |
| OQ-33 | Cache/protection reuse per ADR-0041-consistent recommendations            | **closed** — ADR 0054 |

### Decisions of note (full detail in ADR 0054)

- Public raw pages mirror public images: `301` to `{ASSET_BASE_URL}/pages/{id}/{rev}/source.md`
  via the reused image dispatch branch in `src/entry-serve.ts`; `src/router.ts` unchanged.
- Protected raw pages prompt first, then stream Worker bytes with the **stored** R2
  `httpMetadata` content type and `Cache-Control: no-store` — never a redirect.
- New typed error `invalid_raw_upload` (zero-file requests keep the pre-existing `no_files`);
  `show_source` forced to 0 at create/paste and PATCH-normalized to a no-op on raw rows.
- Replacement `.md` files are stored verbatim as `source.md` through the normal rev-bump path;
  post-create asset adds are allowed and inert. BOM-strip parity with rendered `.md` uploads.

### Known limitations / live follow-ups

- **Dead-object edge (accepted):** a public raw page whose R2 object was deleted directly keeps
  301ing to the dead CDN URL until a file replace (rev bump) or page delete — identical to image
  pages (public serving does no R2 read).
- **R2 cache-extension caveat:** the R2 public-bucket default cache-extension set may not include
  `.md` (roadmap §6); a Cache Everything / custom cache rule may be needed. Live verification is
  an item in `docs/operations/smoke-test-checklist.md` §S24.
