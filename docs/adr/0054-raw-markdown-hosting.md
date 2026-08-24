# 0054: Raw markdown hosting — verbatim `source.md` pages via a new page kind

- Status: accepted
- Date: 2026-08-24

## Context

Operator request (S24): "As a user I want the ability to host raw markdown without it being
converted to HTML. When the user visits a raw markdown page (slug url/cdn url) they should be
served the raw markdown only as text."

Today every `.md` upload is rendered to `index.html` at publish time (spec §7). Serving the
markdown itself requires a different storage shape and serve path, and it interacts with locked
prior decisions: the 1+3 cost model (§3, Worker serves only entry documents), the password-
protection threat model (ADR 0041 decision 6 — the CDN host must never appear in protected
responses), the content-type mapping contract (ADR 0015), and the rev/cache model (ADR 0006).

The planning phase raised seven open questions (OQ-27..OQ-33,
`.work/planner/raw-md-open-questions.md`); **the human approved all recommended options** before
implementation started. This ADR records the approved outcomes plus the implementation
decisions made in slices S24-A..D.

## Decision

### 1. New `PageKind` `"raw-markdown"` (OQ-27, option a)

A new kind, not a per-page render-mode flag. No D1 migration is needed (`kind` is free TEXT,
`migrations/0001_init.sql`). Re-render exclusion is **structural by data shape**: raw rows store
`raw_md_path = null`, so `needsReRender` (`src/admin-api.ts`) can never fire on them — no extra
conditionals on hot paths. Consistent with how `listing` was introduced. The kind union remains
intentionally duplicated in `src/pages-repository.ts` and `src/admin-api.ts` (kept in lockstep;
not refactored into a shared type this slice).

### 2. Entry is always normalized to `source.md` (OQ-28, option a)

One canonical stored name regardless of upload filename: `entry_path = "source.md"`,
`raw_md_path = null`, `show_source = 0`. Mirrors the existing normalization precedent (HTML →
`index.html`; rendered markdown stores `source.md`). Keeps file-replace/delete guards simple.
The original filename survives in the page title (`deriveTitle`).

### 3. Public serving = 301 to the CDN object (OQ-29, option a)

Public raw entries reuse the proven image-kind pattern: `301` +
`headersFor("redirect", page.id)` + `Location =
{ASSET_BASE_URL}/pages/{id}/{rev}/source.md`. The Worker stays out of the hot path after one
metered request; the `redirect` cache class (`public, max-age=300,
stale-while-revalidate=3600` + `Cache-Tag: page-{id}`) gives purge-on-mutation for free.
"Served as text" is preserved — the browser ends up displaying the raw text inline.

**Image-branch reuse:** `src/entry-serve.ts` extends the existing `page.kind === "image"`
dispatch condition to also match `"raw-markdown"` rather than adding a parallel branch — the
semantics are byte-for-byte identical. **`src/router.ts` needed zero change**: slug/id
classification and trailing-slash behavior are kind-agnostic (verified in S24-C).

**Accepted edge (recorded deliberately):** a public raw page whose R2 object was deleted
directly (out-of-band) keeps 301ing to the dead CDN URL — the public path does no R2 read,
identical to image pages. Recovery is a file replace (rev bump) or page delete. Documented in
the operator checklist.

### 4. Content type: per-object override `text/plain; charset=utf-8` (OQ-30/31)

UX-driven choice: browsers display `text/plain` inline but typically download `text/markdown`,
which would defeat the feature's stated intent.

- **At publish**, the raw branch of `buildR2Files` stores the single `source.md` object with the
  literal `RAW_MARKDOWN_CONTENT_TYPE = "text/plain; charset=utf-8"` (also recorded in D1
  `files.content_type`).
- **The global `.md` mapping in `src/content-type.ts` is untouched** (OQ-31, option a). This was
  the single biggest regression trap: changing the table globally would alter behavior only for
  objects written _after_ the change (R2 `httpMetadata` is immutable per object), producing
  mixed types across revs/pages, and would touch the locked ADR 0015 contract. Existing rendered
  pages keep `text/markdown` on their `source.md` objects forever.
- **The serve path reads stored metadata, not a literal:** protected raw responses use the R2
  object's `httpMetadata.contentType` (`stored.contentType`), exactly like protected images.
  There is no hardcoded content type anywhere in `entry-serve.ts`; correctness is guaranteed by
  what publish wrote.

### 5. Upload surface: `manifest.kind` / JSON `kind`; mode switching NOT planned (OQ-32)

`kind: "raw-markdown"` is accepted on multipart uploads and on the JSON paste endpoint
(paste sends `{content, format: "markdown", kind: "raw-markdown"}`). No separate boolean
manifest field (it would collide with `kind` when both present). A post-create rendered↔raw
toggle was considered (option c) and **explicitly rejected by the operator — it is not planned
and not merely deferred**. If ever revisited, it needs a rev-bumping rebuild flow
(`entry-change`) and should be its own slice; no such slice exists today.

### 6. Caching + protection interactions (OQ-33, option a)

Zero new cache/re policy surface: `src/cache-headers.ts` and `src/rev.ts` are untouched. Raw
uploads are `create`/`file-add` actions (rev bump via the normal path); metadata edits stay
`meta-edit` (no bump). The S23 password gate runs before any kind dispatch, so protected raw
pages prompt first; unlocked protected entries stream Worker bytes with
`headersFor("protected")` (`Cache-Control: no-store`) — never a 301, which would leak the CDN
host URL (ADR 0041 decision 6). The known ADR 0041 residual risk applies unchanged: anyone who
previously had/guessed the CDN URL can still fetch the object directly.

### 7. Error taxonomy: dedicated `invalid_raw_upload` (S24-B)

Invalid raw combinations (files present but not exactly one `.md`/`.markdown`) return a typed
`400 invalid_raw_upload` rather than reusing `ambiguous_entry`: that code's message advises
"Provide manifest.entry", which is wrong guidance for a raw page whose entry is always
normalized to `source.md`. A zero-_file_ raw request keeps the pre-existing **`no_files`**
error — the empty-body check runs before kind detection; `invalid_raw_upload` applies only to
requests that carry files but an invalid raw combination.

### 8. `show_source` normalization on raw rows (S24-B/S24-D)

`show_source` is forced to `0` at create/paste (a `showSource` value in a raw request body is
ignored, not rejected — consistent normalization). On PATCH, `handlePatchPage` deletes
`patch.show_source` for raw rows: `needsReRender` is already inert (`raw_md_path = null`), but
without the guard `updateMeta` would persist the patched value and desynchronize the row from
the "show_source is always 0 for raw" invariant. The admin UI hides the checkbox on both create
tabs and on the edit page (OQ-33: the whole page IS the source; a view-source link inside a
plain-text response is meaningless).

### 9. Byte handling: BOM-strip parity, verbatim otherwise (S24-B)

A leading UTF-8 BOM is stripped exactly like rendered-`.md` handling (the form parser does it
before `admin-api` sees the bytes). Beyond that, bytes are stored **verbatim** — no template
wrapper, no `<html>`, no transformation of any kind.

### 10. File operations after create (S24-B)

- **Replacing the entry:** a replacement `.md` upload via `POST /api/pages/{id}/files` is stored
  verbatim as `source.md` through the normal rev-bump path; the old rev folder is retained for
  GC (existing policy).
- **Post-create asset adds are allowed and inert** (orchestrator decision): non-markdown files
  added later are stored under their own paths and do not affect the entry — they are simply
  unreferenced by a plain-text document.
- `source.md` cannot be deleted individually (`isProtectedEntryPath` protects it like any
  entry); delete the whole page instead.
- Mode switching after create is unsupported (decision 5); there is deliberately no conversion
  path in either direction.

### 11. Admin UI surface (S24-D)

Both create tabs gain a "Raw markdown (no HTML)" radio in the existing Page-kind group, wired
to `manifest.kind` / JSON `kind`; selecting it hides the show-source control, the tags/entry
fields, and shows an explanatory hint. The dashboard/edit badge maps `"raw-markdown"` to a new
`icon-file-text` sprite symbol (ADR 0047 conventions: stroke-based, `currentColor`, 24×24).
Errors surface through the shared error box/toast as for every other kind. Without JavaScript
the forms still POST server-side with their static `action`/`method` attributes — identical
graceful-degradation posture to the listing-kind radios.

### 12. Platform caveat (live verification required)

The R2 public-bucket default cache-extension set may not include `.md` (roadmap §6 verified
platform facts). If so, CDN-host responses for `source.md` might not be edge-cached as expected
until a Cache Everything / custom cache rule is added. This cannot be proven under local
emulation — it is a live item in the operator smoke-test checklist.

## Consequences

- Operators can host plain-text markdown with zero rendering, zero template coupling, and
  image-class serving costs (one Worker hit per cache window for public pages).
- The spec gains a sixth page kind (§4) and two surgical behavioral notes (§6, §11); API docs
  document the new kind and error code (`docs/api/admin-api.md`).
- Rendered-markdown behavior is provably unchanged: same global content-type table, same
  `source.md` objects, same show_source re-render path (`needsReRender` untouched because raw
  rows can never satisfy its precondition).
- Foreclosed for now: rendered↔raw conversion (rejected, decision 5), download-vs-inline UX
  controls, syntax-highlighted raw views. Nothing prevents adding them later without breaking
  the stored shape.
- Bundle size grows by one small SVG symbol (~250 B raw) — covered by the build gate.

## Cross-references

- Spec: §4 (content model), §6 (asset resolution), §7 (markdown handling), §11 (public serving)
- ADRs: 0006 (caching/rev model), 0015 (content-type mapping — untouched), 0041 (password
  protection decision 6), 0047 (icon sprite conventions)
- Docs: `docs/api/admin-api.md` (kind field, paste body, raw section, `invalid_raw_upload`),
  `docs/operations/smoke-test-checklist.md` §S24 (live items incl. the cache-extension caveat),
  `docs/development/roadmap.md` §12 (slice table)
- Code: `src/pages-repository.ts`, `src/admin-api.ts` (`RAW_MARKDOWN_CONTENT_TYPE`,
  `invalid_raw_upload`, PATCH normalization), `src/entry-serve.ts` (image-branch reuse),
  `src/admin-ui.ts` (kind radios, badge icon, edit-page show_source suppression)
- Open questions: OQ-27..OQ-33 — all closed (approved recommendations; see roadmap §12)
