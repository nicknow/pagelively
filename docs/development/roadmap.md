# Pagelively — Development Roadmap (living plan)

Status: **approved** (human, 2026-07-30) — Phase 1 plan locked; Phase 2 (architecture) next.
Last updated: 2026-07-31.

Source of truth for _what_ we build: `docs/product-spec.md` (§refs below point at it). This
roadmap is the slice-by-slice plan: ordering, acceptance criteria, risks, open questions.
It lives here because future developers and agents need it; full draft acceptance criteria
and spec cross-references are regenerable scratch under `.work/planner/`.

---

## 0. How to read and update this document

- **Slice statuses** are one of: `planned` → `in-progress` → `done` → `blocked` (note the
  reason). The orchestrator/implementer flips them as slices close. All are `planned` today.
- **Order matters.** Slices are numbered in build order within milestones; the critical path
  in §3 is the only hard sequence. Parallelizable slices can proceed on separate branches,
  but the per-slice loop (tests → code → gates → validate → review → commit) never overlaps
  within a slice.
- **Open questions (§5) must be resolved before the slices marked "blocking" start.**
  Resolutions get recorded as ADRs (Phase 2) or as notes in this file.
- **Platform facts (§6) are dated and sourced.** Cloudflare limits/pricing drift; re-verify
  with `cfdocs` before any slice that depends on a number here, and update this file.
- **When reality diverges from this plan** (slices merge/split, scope changes): update this
  file in the same commit, note the reason, and surface it in the slice report. Never let
  the roadmap rot while code advances.
- Deferred/future items (§17 of the spec) are listed in §7 and are **not** slices.

---

## 1. Milestones and slice table

Status legend: `planned` (default), `in-progress`, `done`, `blocked`. Size: S/M/L.

### M1 — Pure logic, infra-light (unit-testable, no bindings)

| ID  | Slice                                   | Size | Status  | Depends on             |
| --- | --------------------------------------- | ---- | ------- | ---------------------- |
| S01 | Slug & id resolution primitives         | L    | done    | —                      |
| S02 | Reserved-word validation                | S    | planned | S01                    |
| S03 | Rev handling (bump policy + key layout) | S    | planned | S01, OQ-04             |
| S04 | `<base>`-tag injection                  | S    | planned | S01, OQ-14             |
| S05 | Markdown rendering pipeline             | M    | planned | S01, S04, OQ-05, OQ-14 |
| S06 | Content-type mapping                    | S    | planned | —                      |
| S07 | Cache-header construction               | S    | planned | S01, OQ-01             |
| S08 | Trailing-slash redirects & clean 404    | S    | planned | S01                    |
| S09 | Home-mode behavior                      | S    | planned | S01, S08, OQ-08        |

### M2 — Binding integration (D1/R2/KV via local emulation)

| ID  | Slice                                                        | Size | Status  | Depends on |
| --- | ------------------------------------------------------------ | ---- | ------- | ---------- |
| S10 | D1 pages repository (reads)                                  | M    | planned | S01        |
| S11 | R2 object store (key layout + metadata)                      | M    | planned | S03, S06   |
| S12 | Entry request pipeline (router + serve + 301 + 404 + health) | L    | planned | S01–S11    |
| S13 | Entry-HTML edge cache integration                            | M    | planned | S12, OQ-01 |
| S14 | KV-backed JWKS cache (optional, degrades gracefully)         | S    | planned | —          |

### M3 — Admin, upload, auth

| ID  | Slice                                                | Size | Status  | Depends on               |
| --- | ---------------------------------------------------- | ---- | ------- | ------------------------ |
| S15 | Admin API: list & detail                             | M    | planned | S10, S12, S16            |
| S16 | Access JWT verification (defense-in-depth gate)      | M    | planned | S14, OQ-12               |
| S17 | Upload & publish API (multipart, manifest, kinds)    | L    | planned | S12, S16, OQ-04/05/06/11 |
| S18 | Edit & delete API (PATCH/DELETE, file ops, rev bump) | M    | planned | S17, OQ-04               |
| S19 | Admin UI (buildless dashboard/upload/edit)           | L    | planned | S17, S18                 |

### M4 — Setup & deploy (human-run; unit-tested with mocks)

| ID  | Slice                                             | Size | Status  | Depends on                |
| --- | ------------------------------------------------- | ---- | ------- | ------------------------- |
| S20 | setup.mjs provisioning (idempotent, mocked tests) | L    | planned | S15–S18 surface, OQ-09/10 |
| S21 | GitHub Actions deploy workflow + quickstart docs  | S    | planned | S20                       |

### M5 — End-to-end

| ID  | Slice                                                | Size | Status  | Depends on |
| --- | ---------------------------------------------------- | ---- | ------- | ---------- |
| S22 | End-to-end smoke + operator checklist + DoD closeout | L    | planned | all above  |

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

**S02 — Reserved-word validation** — every §5 name (`p, api, admin, assets, favicon.ico,
robots.txt, health, sitemap.xml`) rejected as a slug; `_`-prefixed slugs rejected;
near-misses (`admin2`, `p-2`) accepted. Semantics per OQ-02 (default: exact-match + `_`
prefix, lowercase-only slugs). NOTE (S01 validation): the edge Access application protects
`/admin*` (spec §9), so a Worker-accepted near-miss slug such as `adminx` would be
Access-challenged at the edge before the Worker classifies it — more restrictive, not a
security hole; record the path rules in the S20/S22 ops/smoke docs.

**S03 — Rev handling** — `nextRev(1)=2`; key builder emits `pages/{id}/{rev}/{path}` (§8);
`shouldBumpRev` true only for content-affecting actions (OQ-04 default); path-escape
(`../`) rejected; unknown action type throws.

**S04 — `<base>`-tag injection** — base injected as first `<head>` element, href
`{ASSET_BASE_URL}/pages/{id}/{rev}/` (§6); `<head>` created if absent; existing `<base>`
replaced; malformed HTML never throws. Serve-time injection for all kinds (OQ-14 default).

**S05 — Markdown rendering pipeline** — `# Hi` → `<h1>Hi</h1>` via `marked` (§7, §14);
output wrapped in minimal responsive template with base slot; `show_source` adds a link to
`source.md` (§7); raw HTML rendered iff `ALLOW_RAW_HTML_IN_MD` true, escaped otherwise;
bundle entries that are `.md` go through the same pipeline (OQ-05). Bundle-size gate
(`npm run build`) stays green (3 MB compressed free limit, §15).

**S06 — Content-type mapping** — §6 whitelist (png/jpg/jpeg/gif/webp/svg/avif, css, js,
fonts) + `.md` → `text/markdown` + `.html` → `text/html; charset=utf-8`; unknown →
`application/octet-stream`; table is data, extensible (§6).

**S07 — Cache-header construction** — assets: `public, max-age=31536000, immutable`;
entry: `public, max-age=…, stale-while-revalidate=…` + `Cache-Tag: page-{id}` (values per
OQ-01); admin/API: `no-store`; never emits `s-maxage` with SWR (§11; verified semantics).

**S08 — Trailing-slash redirects & clean 404** — `/{slug}` → 301 `/{slug}/`, `/p/{id}` →
301 `/p/{id}/` (§5); root and `/health` never redirected; 404 clean HTML page for unknown
paths (§11); no redirect loops on encoded slashes.

**S09 — Home-mode behavior** — `HOME_MODE=page` + valid `HOME_PAGE_SLUG` → `/` serves that
page's entry (§11); `HOME_MODE=404` / unset / bad slug → 404; unknown mode value → 404.

**S10 — D1 pages repository (reads)** — `getById`/`getBySlug`/`listPages` (created_at DESC)
against the real migrated schema (§8); null on miss; visibility filtering helper; slug
uniqueness constraint asserted; queries stay index-covered (D1 free tier: 5 M rows
read/day).

**S11 — R2 object store** — put/get/delete/list under `pages/{id}/{rev}/…` (§8); bytes
round-trip; httpMetadata carries content type + immutable Cache-Control (verified: R2
stores and echoes it); folder paths preserved (§6); `deletePageObjects(id)` paginates;
missing object → null.

**S12 — Entry request pipeline** — `GET /{slug}/` and `GET /p/{id}/` serve the entry with
injected base, `text/html; charset=utf-8`, per-route Cache-Control (§5, §6, §11); markdown
serves rendered HTML; image page → 301 to `{ASSET_BASE_URL}/pages/{id}/{rev}/{entry}`;
`/health` stays public 200 (Phase 0 contract kept); unknown → 404; errors → generic 500
with `no-store`, no stack leakage. Rewires `src/index.ts` away from the Phase 0 stub.

**S13 — Entry-HTML edge cache integration** — `[cache] enabled = true` in wrangler.toml
(types regenerated); entry responses carry `Cache-Tag: page-{id}`; publish/edit purges
`{tags:["page-{id}"]}` via `ctx.cache.purge` (or `cache.purge` imported from
`cloudflare:workers` — verified API); purge is scoped to the Worker + entrypoint, which
works here because admin and entry handlers share the default entrypoint (keep it that way
— Phase 2 note); purge failure non-fatal; admin/API uncached (§11). Deploys start with a
cold cache (Worker version is part of the cache key by default — acceptable for this
workload; do not enable `cache.cross_version_cache`). If the pool can't emulate cache
HITs, live HIT verification is an operator checklist item (risk R2) — never faked.

**S14 — KV-backed JWKS cache** — cache Access JWKS in KV (TTL ~1 h), refetch on
miss/stale/corrupt; KV absent → fetch every time (§2, §9); write failures ignored; fetch
failure → fail closed at the gate.

**S15 — Admin API: list & detail** — `GET /api/pages` → ordered JSON (title, slug, id,
kind, created_at, visibility, show_source, rev); `GET /api/pages/{id}` → page + files
list (§5, §8); unknown id → 404 JSON; invalid id → 400; unauthenticated → 403 (S16 gate
asserted end-to-end).

**S16 — Access JWT verification** — verify `Cf-Access-Jwt-Assertion` on `/admin*` and
`/api/*` (§9): signature vs JWKS at `https://{ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`
(verified), `aud` == `ACCESS_AUD`, `iss` == team domain, expiry (±60 s skew); locally
generated keypairs + mock JWKS covering **valid / expired / wrong-aud / tampered / unknown
kid / missing / malformed** → all bad cases 403, never pass-open; `email` claim extracted
for the dashboard; unset `ACCESS_AUD` → fail closed.

**S17 — Upload & publish API** — `POST /api/pages` multipart + manifest (§10): single
`.html` → html page; single `.md` → markdown page (render + `source.md` + `raw_md_path`);
single image → image page; bundle preserves relative paths (§6); auto-slug (S01) with
reserved (S02) and uniqueness (S10) checks → 409 on collision; ambiguous entry → 400 (OQ-11);
upload body guard ~95 MB (413; verified 100 MB Cloudflare limit); `../` paths rejected;
partial D1 failure → best-effort R2 rollback, no orphan rows; 201 + page JSON, rev = 1.
NOTE (S01 validation): trim the filename/title before `slugify` in the API layer —
`"My Post 1.md "` currently slugifies to `my-post-1-md`.

**S18 — Edit & delete API** — slug/title/visibility/show_source PATCH with uniqueness +
reserved checks; file add/replace/delete with rev bump per OQ-04 (fresh folder, `files`
rows re-pointed, old folder left for GC per OQ-10); `DELETE /api/pages/{id}` removes rows
(cascade) + all objects (§10); entry file not deletable; every mutation purges the page's
cache tag (§11); 404 on missing page; 409/422 on conflicts.

**S19 — Admin UI** — `GET /admin` dashboard (title, slug, id, kind, created, view/edit/
delete links); upload form (multi-file, `webkitdirectory`, slug, show-source, entry picker
when ambiguous) posting multipart to S17; edit form pre-filled; delete with confirm;
verified email shown (§9); "Pagelively" product name present (§10); empty state CTA;
API errors surfaced; buildless (§10, §14).

**S20 — setup.mjs** — §13 steps 1–11 with mocked Cloudflare API + mocked wrangler calls:
idempotent resource creation (list-then-create per resource; double-run creates nothing
new), Access app over `/admin*` + `/api/*` with email policy → captures `aud` + team
domain, R2 bucket → CDN domain via API + `ASSET_BASE_URL` written, wrangler.toml/overlay
updated with real IDs, `wrangler d1 migrations apply`, Zero Trust not initialized → print
steps and pause; token and interactive auth; partial-failure resume; missing zone → clear
pre-deploy error; `setup.sh`/`setup.ps1` wrappers exist (§13).

**S21 — GitHub Actions + quickstart** — manual-dispatch `deploy.yml` using repo secrets
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ADMIN_EMAILS`) running `npm ci` +
setup (§13); YAML parses; README documents Node prerequisite (Linux + Windows 10/11) and
the §13 token scopes verbatim.

**S22 — End-to-end + operator checklist + DoD** — full local journey (create html page →
slug + id URLs serve with base → bundle with nested assets → markdown with show-source →
edit slug → delete, rows+objects gone); reserved slug rejected through UI → API → 4xx;
home modes exercised; `npm run build` size under the free limit; clean-devcontainer
quickstart works; deliverable `docs/operations/smoke-test-checklist.md` covering the
infra seams (R2 CDN serving + immutable headers, Worker custom domain + DNS, live Access
login → JWT verified, entry `Cf-Cache-Status: HIT`, purge-on-publish freshness, free-tier
quota verification). All OQs closed or explicitly deferred.

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

| ID    | Question                                                                                                                      | Spec     | Recommendation                                                                                                                                                         | Decider           | Blocks        | Status             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------- | ------------------ |
| OQ-01 | Entry-cache design: §11's "Cache API + s-maxage + SWR" contradicts current docs (s-maxage disables SWR; no SWR in Cache API). | §11      | Workers Caching (`cache.enabled`) + `public, max-age=300, stale-while-revalidate=3600` + `Cache-Tag: page-{id}` + `ctx.cache.purge({tags})` on publish (verified API). | Human + architect | S07, S13      | decided            |
| OQ-02 | Reserved-word semantics: which §5 entries are exact-match vs prefix?                                                          | §5       | Exact-match for all names; `_` is the only prefix rule; slugs lowercase-only.                                                                                          | Human             | S02           | decided            |
| OQ-03 | Slug auto-generation algorithm + collision handling.                                                                          | §4       | slugify (lowercase, `-` for non-alnum); collisions get deterministic `-2`/`-3`; fallback to id-prefix.                                                                 | Architect         | —             | decided (ADR 0007) |
| OQ-04 | Which admin actions bump `rev`.                                                                                               | §8, §11  | Content-affecting only (file/entry changes, re-render); metadata edits don't bump — cache purge covers them.                                                           | Architect + human | S03, S17, S18 | decided            |
| OQ-05 | Bundle with `.md` entry: render through §7 pipeline?                                                                          | §4, §7   | Yes — one Markdown code path; kind stays `bundle`.                                                                                                                     | Architect         | S05, S17      | decided            |
| OQ-06 | Non-image single raw file (PDF): new kind or reject?                                                                          | §4, §6   | Allow as `bundle` with 301-to-CDN serving ("raw-file pages" hint).                                                                                                     | Human             | S17           | decided            |
| OQ-07 | Clean 404 for assets: CDN host has no Worker; R2 returns its own 404.                                                         | §11      | Accept R2's default 404 in v1; clean page covers Worker-host misses only.                                                                                              | Human             | —             | decided            |
| OQ-08 | `HOME_MODE=page`: serve at `/` or redirect?                                                                                   | §11      | Serve directly (spec-literal); `/{slug}/` stays canonical.                                                                                                             | Human             | S09           | decided            |
| OQ-09 | `PUBLIC_LISTING` var (§12) vs deferred listing (§16).                                                                         | §12, §16 | Keep placeholder var, no v1 behavior; documented deferred.                                                                                                             | Human             | —             | decided            |
| OQ-10 | Rev GC "after a grace period" — no mechanism specified.                                                                       | §8       | No GC in v1; ops note + manual cleanup; future automation.                                                                                                             | Human             | —             | decided            |
| OQ-11 | Entry detection when manifest absent/ambiguous.                                                                               | §10      | Server 400 with clear message; UI forces entry picker when ambiguous.                                                                                                  | Architect         | S17           | decided            |
| OQ-12 | `ACCESS_TEAM_DOMAIN` bare domain vs URL.                                                                                      | §9, §12  | Store bare; code prepends `https://`; strip scheme defensively.                                                                                                        | Architect         | S16           | decided            |
| OQ-13 | "Re-render all Markdown" (§7) vs deferred (§17).                                                                              | §7, §17  | Defer per §17; roadmap records it.                                                                                                                                     | Human             | —             | decided            |
| OQ-14 | Base tag: bake into markdown template (§7) vs serve-time injection (§6).                                                      | §6, §7   | Uniform serve-time injection; template links stay relative; no stale-rev risk; no rev bump on show_source toggle.                                                      | Architect + human | S04, S05, S12 | decided            |

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
- Access API: `GET/POST /accounts/{account_id}/access/apps`; permission "Access: Apps and
  Policies Write"; app `aud` captured for `ACCESS_AUD`.
  https://developers.cloudflare.com/cloudflare-one/access-controls/applications/linked-app-token/
- Local D1 migrations + Workers-pool test emulation: Phase 0 ADR 0001 (verified then;
  re-verify on upgrades). https://developers.cloudflare.com/workers/testing/vitest-integration/

---

## 7. Explicitly deferred (spec §16/§17 — not slices)

Zip upload (needs `fflate`), public listing at `/`, "re-render all Markdown" (OQ-13),
root-relative link rewriting, multipart R2 uploads for large media, per-page
password/expiry/analytics, optional SPA admin, rev GC automation (OQ-10), theme selection.
They belong in the open-questions log / future list, never silently in code (brief
boundaries).

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
