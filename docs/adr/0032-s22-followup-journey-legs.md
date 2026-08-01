# 0032: S22 follow-up — journey extended to the acceptance criteria's full leg list

- Status: accepted
- Date: 2026-08-01

## Context

S22 validation (ADR 0031) passed, but the reviewer flagged one documentation-vs-test
deviation: the roadmap's S22 acceptance criteria describe the full local journey as
"create html page → slug + id URLs serve with base → bundle with nested assets → markdown
with show-source → edit slug → delete, rows+objects gone" plus "reserved slug rejected
through UI → API → 4xx", while `test/e2e.test.ts` covered create/serve/bundle/delete/home
modes — markdown+show-source, the slug edit, and the reserved-slug rejection were only
covered by separate per-slice tests, not as journey legs.

No production behavior was missing: `admin-api-publish.test.ts` proves the markdown
publish path, `admin-api-edit.test.ts` proves the slug-edit PATCH, `reserved.test.ts` /
`slug-validation.test.ts` prove the reserved-name rejection, and `admin-ui.ts` ships the
upload-error surface. The gap was the journey not exercising them end-to-end.

## Decision

1. **Extend the journey in place (`test/e2e.test.ts`), 13 → 16 steps, preserving the
   existing 13 steps unchanged** (same assertions, same relative order) and inserting the
   three missing legs at the acceptance criteria's positions: markdown with show-source
   after the nested-asset bundle (step 8), the slug edit after the file-delete leg (step
   13), and the reserved-slug rejection between the page delete and the home-404 mode
   (step 15). The page created for the html leg (the home page) is the one whose slug is
   edited — reusing state, as the AC implies the edit happens on an existing page.

2. **Markdown leg matches the established spec semantics — no new route invented.**
   `POST /api/pages` with a single `.md` + `showSource: true` → 201, kind `markdown`,
   `raw_md_path: source.md`, `show_source: 1`; `GET /{slug}/` serves the rendered HTML
   with the injected `<base>` and the relative `View source` link; the raw `source.md`
   object lives on the CDN path (spec §6 — assets are served by the R2 CDN host, which
   the journey emulates as the R2 object with upload-time bytes + `httpMetadata`, exactly
   like the other asset objects); and the Worker 404s the raw path (`/notes/source.md` →
   clean 404) because the router has no asset route — spec §6 keeps the Worker out of the
   asset path.

3. **Slug-edit leg matches `admin-api-edit.test.ts` / `slug.test.ts` / `redirects.test.ts`
   semantics.** `PATCH /api/pages/{id}` with a new slug → 200 with `rev` unchanged
   (metadata-only, ADR 0012); the new slug serves 200 with the same base; the old slug
   serves a clean 404 with `Cache-Control: no-store` (there is no rename-redirect table —
   nothing maps old → new); the id URL still serves.

4. **Reserved-slug leg asserts the pre-existing UI surface, not the dashboard.**
   The instruction to assert the "error-surfacing markup the S19 UI already renders for
   upload errors" was scoped to pre-existing behavior: the upload-error box
   (`<div class="error" id="upload-error" role="alert">`) is rendered by the upload page
   handler (`/admin/upload`), **not** by the dashboard (`/admin` — `dashboardContent` has
   no such element). The journey therefore asserts the markup on `GET /admin/upload` (the
   page that actually surfaces upload errors) and separately asserts `GET /admin` still
   serves. `POST /api/pages` with a reserved slug → `400 { error: "invalid_slug" }` with
   `Cache-Control: no-store`, and zero orphan rows/objects — the rejection fires in
   `validateManifest` before `generateId()` and before any R2 write, so nothing can be
   left behind.

5. **No production code changed.** The journey re-exercises shipped behavior only.

## Citations

- `docs/product-spec.md` §5 (API), §6 (CDN asset serving — "bypassing the Worker"), §7
  (show-source link to `…/pages/{id}/{rev}/source.md` on the CDN host).
- ADR 0031 decision 2 (original 13-step journey; this ADR extends it).
- `src/admin-ui.ts` (`uploadContent`: `#upload-error` on `/admin/upload`; `dashboardContent`:
  no error box on `/admin`).
- `src/admin-api.ts` (`validateManifest` precedes `generateId` and the R2 writes).
- `test/admin-api-publish.test.ts`, `test/admin-api-edit.test.ts`, `test/slug.test.ts`,
  `test/redirects.test.ts`, `test/reserved.test.ts` (per-slice semantics the journey
  mirrors).

## Consequences

- The journey now covers the acceptance criteria's full leg list and stays one sequential
  file (16 steps); the roadmap S22 Done note and ADR 0031 decision 2 were updated to match.
- Suite grows by 3 tests (973 → 976); coverage is unchanged (the journey re-exercises
  covered code — 99.69/97.26/97.83/99.91 at close).
- A future reader asked to "fix" the reserved-slug leg into the dashboard will find the
  decision recorded here: the upload-error surface is on the upload page by design.
