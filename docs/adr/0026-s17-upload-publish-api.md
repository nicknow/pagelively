# 0026: S17 upload & publish API — multipart path convention and page kind detection

- Status: accepted
- Date: 2026-08-01

## Context

Slice S17 implements the `POST /api/pages` upload/publish endpoint. Three decisions needed
resolution before implementation:

1. **Multipart file path convention.** The spec §10 says the client sends a manifest plus file
   bytes as `multipart/form-data`. The browser `webkitdirectory` upload gives each file a
   `webkitRelativePath`, but the simplest testable contract needed to be fixed.
2. **Page kind detection.** The spec distinguishes `html`, `markdown`, `image`, and `bundle`
   pages. The exact rules for when a multi-file upload becomes a bundle and how the entry is
   picked were not fully enumerated.
3. **Failure handling for the R2-then-D1 write sequence.** Writes to R2 and D1 are not
   atomic. A D1 failure after R2 writes must not leave orphaned objects or rows.

## Decision

### 1. File parts are keyed by `file:<path>`

The multipart contract is:

- One `manifest` field containing a JSON string: `{ slug?, title?, showSource?, entry?, visibility? }`.
- One file part per uploaded file, with the part name `file:<relative-path>` (e.g.
  `file:images/pic.png`). The file's original `filename` is stored for diagnostics only;
  the canonical path is the part name after the `file:` prefix.

This is simpler than relying on `webkitRelativePath` or an extra manifest path map, and it is
straightforward to construct in tests. The form parser rejects:

- `%` anywhere in the path or filename (literal `%` in an R2 key is unservable per ADR 0012).
- `../` or leading `/` (path traversal), and backslashes.
- Empty paths.
- A leading UTF-8 BOM on `.md` / `.markdown` file content is stripped before rendering.

### 2. Kind detection rules

Files are classified as **documents** (`.html`, `.htm`, `.md`, `.markdown`) or **images**
(`isImageContentType`). All other files are treated as assets.

| Upload shape                                                                                       | Kind       | Entry path                                               |
| -------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------- |
| Exactly one `.html` / `.htm` document (any number of non-document assets, including images)        | `html`     | `index.html`                                             |
| Exactly one `.md` / `.markdown` document (any number of non-document assets, including images)     | `markdown` | `index.html` (raw stored as `source.md`)                 |
| Exactly one image and no documents                                                                 | `image`    | the image filename                                       |
| Anything else: multiple documents, an image with other assets, no clear entry, or a manifest entry | `bundle`   | manifest `entry` (or the single non-ambiguous candidate) |

A bundle whose entry is a `.md` file is rendered through the same markdown pipeline as a
`markdown` page, but `kind` stays `bundle` (OQ-05). The rendered HTML is stored as
`index.html` and the raw Markdown as `source.md`.

### 3. R2-then-D1 write sequence with best-effort rollback

The handler writes to R2 first, then inserts the D1 page row and file rows. If any D1 write
fails after R2 objects were created, the handler:

1. Deletes all objects under `pages/{id}/` via `objectStore.deletePageObjects`.
2. Deletes the page row via `pagesRepository.delete` (cascade removes any partial file rows).

The result is returned as `db_write_failed` (or the original `AppError`) and `no-store` headers.
This is best-effort: if the rollback itself fails, the error is logged but the response still
reports the original failure; the operator checklist covers monitoring for orphaned objects.

### 4. Rev starts at 1 for new pages

Per spec §8 and ADR 0012, `rev = 1` for creates. `applyRevBump` and `delete` are added to the
repository now so S17's rollback can use them; they are otherwise exercised in S18.

## Consequences

- Tests can build multipart bodies with deterministic paths without browser machinery.
- The write-side path security is stricter than `buildR2Key` alone: the form parser rejects
  `../` and `%` before the R2 key builder is ever called.
- Image files uploaded alongside an HTML document are treated as assets of an `html` page, not
  as a bundle, matching the spec §4 "optionally with accompanying asset files" wording.
- The `POST /api/pages` response body mirrors the detail endpoint (`PageRecord` + `files[]`) with
  status 201 and `Cache-Control: no-store`.

## Cross-references

- Spec: §4 (page kinds), §6 (asset references), §7 (markdown handling), §8 (storage schema), §10
  (upload flows).
- Docs: `docs/api/admin-api.md`, `docs/operations/smoke-test-checklist.md`.
- ADRs: 0012 (R2 key builder), 0014 (markdown rendering), 0025 (admin API list/detail).
- Code: `src/form-parser.ts`, `src/admin-api.ts`, `src/pages-repository.ts`,
  `src/files-repository.ts`, `src/index.ts`.
