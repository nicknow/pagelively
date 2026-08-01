# 0031: S22 — end-to-end smoke journey, build-size gate, and closeout findings

- Status: accepted
- Date: 2026-08-01

## Context

S22 is the end-to-end / DoD closeout slice. Its acceptance criteria require (a) an
end-to-end smoke test covering the full local journey, (b) proof the built bundle stays
within the Workers Free size limits, (c) a finished operator checklist, and (d) validation
of the checklist's live-only checks against the actual router/API surface (test standards #5
— infra seams are never faked locally).

Two constraints shaped the work:

1. **The test pool has no host filesystem access.** Tests run inside `workerd` (Workers
   Vitest pool — ADR 0003). `node:fs` inside the pool is a virtual per-request FS, not the
   host — verified by probe during S22. A size gate cannot `readFile` the build output.
   `test/github-actions.test.ts` (S21) already worked around this by importing committed
   YAML through Vite's `?raw`; the same pattern applies to `dist/`.
2. **The acceptance-criteria wording did not match the shipped surface in three places**
   (each validated against the running Worker, no source change needed):
   - There is **no `/api/assets/...` route** in `src/router.ts` or `src/index.ts`. Spec §6
     routes asset URLs to the R2 CDN host, "bypassing the Worker" entirely — the admin API
     is the only API surface. "Reserved slug rejected through the full stack" therefore
     means the admin API rejects it (`400 invalid_slug`), and the upload UI surfaces that
     API error — not an asset-serving route rejecting it.
   - `POST /api/pages` returns **201 + JSON without a `Location` header** (spec §5 lists no
     such header); the journey asserts the 201 + JSON contract, not a redirect.
   - Page-kind detection (ADR 0026): a single HTML document + other assets is kind `html`,
     **not** `bundle`; `bundle` requires ≥ 2 documents (or an image + other assets). The
     first bundle attempt in the journey failed because a single-document upload produced
     `html` — the journey uploads two documents for the bundle case.

## Decision

1. **Build-size gate as a test (`test/build-size.test.ts`), not a shell check.** The gate
   locates the built bundle via Vite's `import.meta.glob("../dist/*.js", { query: "?raw",
import: "default", eager: false })` — resolved at transform time, so it needs no fs — and
   compresses it in-pool with `node:zlib.gzipSync` (available in workerd; verified by probe).
   It asserts raw size < 64 MB and gzipped size < 3 MB, the Workers Free limits. Because a
   fresh clone has no `dist/`, the glob returns `[]` and the gate **skips gracefully** via
   `it.runIf(distIndexLoader)`: `npm test` alone never fails on a machine that hasn't built;
   the human gate sequence (build before test) makes the gate actually assert. NOTE: the
   GitHub Actions `deploy.yml` (S21) is deploy-only and does not run the test suite, so this
   gate is enforced on the human build→test path, never in CI.
   Measured at S22: `dist/index.js` = 149,730 B raw / 35,572 B gzip (146.22 KiB / 34.74 KiB).

2. **The journey is one sequential test file (`test/e2e.test.ts`), not per-slice units.**
   One uninterrupted sequence over the emulated Worker (`worker.fetch` with real D1 + R2
   emulation, mock JWKS Access gate — same harness as the admin-API tests), 16 ordered
   steps: health → fail-closed 403 → publish (201, kind `html`, rev 1, id
   `[A-Za-z0-9_-]{8,10}`) → `HOME_MODE=page` at `/` → trailing-slash 301 (absolute
   `Location: https://pages.example.com/home/`) → slug + id entry serve with injected
   `<base>` and R2 objects carrying `httpMetadata` (`content-type` +
   `cache-control: public, max-age=31536000, immutable`) → nested-asset bundle (kind
   `bundle`, entry `site/index.html`, paths under `pages/{id}/{rev}/`) → markdown with
   show-source (kind `markdown`, `raw_md_path: source.md`, `show_source: 1`; rendered
   entry serves with base + relative `View source` link; the raw `source.md` object lives
   on the CDN path — emulated like the other assets; the Worker 404s the raw path, spec
   §6) → admin dashboard (product name, verified email, page links) → metadata `PATCH`
   (200, rev unchanged) → entry-file replace (rev bump, old rev immutable) → file delete
   (rev bump, deleted asset null at current rev) → edit slug (metadata-only PATCH: new
   slug serves, old slug clean 404 — no rename redirect, id URL still serves, rev
   unchanged) → page delete (204; slug/id 404 with `Cache-Control: no-store`; no rows,
   no objects) → reserved slug through UI → API → 4xx (the upload page carries the S19
   `#upload-error` `role="alert"` surface; `POST` with a reserved slug → `400
invalid_slug`; zero orphan rows/objects — the 400 fires before any id is generated or
   any R2 object is written) → `HOME_MODE=404` clean 404. Extended from 13 steps on
   2026-08-01 to the acceptance criteria's full leg list (ADR 0032). Env flips between
   steps are done by passing overrides into `worker.fetch` — the pool cannot hot-swap
   Worker vars mid-file, so the journey drives the handler directly (same pattern as the
   existing `resolveHome` tests).

3. **Acceptance-criteria resolutions, recorded in the checklist, not code:**
   - Reserved-slug full-stack rejection = API `400 invalid_slug` + UI surfacing of the API
     error (there is no asset route to reject with — spec §6).
   - Traversal-ish CDN requests (`/pages/{id}/{rev}/../…`, `/%2e%2e/…`) → the bucket's own
     404 (ADR 0012/S03), and literal-`%` keys are unservable; the API rejects `%` filenames
     (`400 invalid_filename`, S17) before they can reach the bucket. These are live-CDN
     checks in the operator checklist; the local journey asserts the Worker-side 404s.
   - Free-tier quota verification (Workers 100,000 req/day + Error 1027; Worker size 3 MB
     gzip / 64 MB raw; memory 128 MB; CPU 10 ms; 50 subrequests/request; 100 MB request
     body on Free; R2 10 GB-month storage + 1 M Class A / 10 M Class B ops + free egress;
     D1 5 M rows read / 100 k rows written per day) is a **live** checklist section, with
     the bundle-size part double-covered by the automated gate.

## Citations

- Workers limits (requests, size, CPU, memory, subrequests, 100 MB Free body, Error 1027):
  `developers.cloudflare.com/workers/platform/limits/` (retrieved 2026-08-01).
- `wrangler deploy --dry-run` prints `Total Upload: … KiB / gzip: … KiB` — same page.
- R2 pricing (free tier, no egress fees): `developers.cloudflare.com/r2/pricing/`.
- D1 pricing (rows read/written per day): `developers.cloudflare.com/d1/platform/pricing/`.
- Workers Vitest integration (pool, bindings): `developers.cloudflare.com/workers/testing/vitest-integration/` (ADR 0003).
- Spec: §5 API (201 create, no Location), §6 CDN asset serving ("bypassing the Worker"),
  `docs/product-spec.md`.

## Consequences

- `dist/` stays gitignored and the gate degrades to a skip on clones without a build; the
  gate sequence contract (build → test) is documented in the checklist, so CI and the
  human's verification always measure the real artifact. If a future slice changes the
  bundle approach (e.g., Static Assets — limits page: 20,000 files Free), the gate's glob
  would need revisiting.
- The journey adds ~17 tests (959 → 976, extended to the AC's full leg list — ADR 0032)
  and is intentionally sequential: any step failing
  leaves the rest skipped-in-effect (later steps depend on earlier state), which is the
  point of a smoke test. Coverage is unchanged (the journey re-exercises covered code).
- `test/env.d.ts` gained minimal `ImportMeta.glob` and `node:zlib` type shims (the pool
  doesn't provide `@types/node`); the `*?raw` module declaration precedent is reused.
- No production code changed in S22: validation found the app already implements the
  criteria; the three wording mismatches above are recorded here and in the checklist so a
  future reader doesn't "fix" them back into existence.
