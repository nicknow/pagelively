# 0038: Paste content API — same endpoint, application/json, synthetic file pipeline

- Status: accepted
- Date: 2026-08-02

## Context

OQ-17 asked how to let operators paste HTML/Markdown content into the admin UI without the
multipart upload ceremony. The options were:

1. Add a separate endpoint (e.g., `POST /api/pages/paste`) for JSON content.
2. Add a `content` field to the existing multipart form.
3. Reuse `POST /api/pages` and branch on `Content-Type: application/json`.

A related question was whether the paste endpoint should also support replacing content on an
existing page (PATCH content) or stay create-only for this task.

## Decision

`POST /api/pages` accepts both `multipart/form-data` and `application/json` (OQ-17, create-only
first; replace-on-edit is a follow-up). The JSON body is:

```json
{
  "content": "<h1>Hi</h1>",
  "format": "html" | "markdown",
  "slug?": "...",
  "title?": "...",
  "visibility?": "public" | "unlisted",
  "showSource?": true | false
}
```

The JSON path constructs a synthetic file (`pasted.html` or `pasted.md`) and feeds it into the
same create pipeline as the multipart path: `determineKindAndEntry` → `validateManifest` →
`resolveSlug` → `buildR2Files` → 201 response. Markdown pastes therefore render through the
existing Markdown pipeline to `source.md` + `index.html`; HTML pastes are stored as `index.html`.

Validation is done in the JSON parser before the pipeline is reached:

- Invalid/missing JSON → `400 invalid_json`.
- Missing/non-string/empty/whitespace-only `content` → `400 invalid_content`.
- Missing/invalid `format` → `400 invalid_format`.
- UTF-8 byte length of `content` > 1_000_000 → `413 content_too_large` (nothing stored).

The multipart path is unchanged; the two paths share one create core so they cannot drift.

## Consequences

- **One endpoint, one create pipeline** keeps the API surface small and guarantees that Markdown
  pastes and Markdown file uploads produce identical output.
- **Synthetic file abstraction** means the existing kind detection, slug resolution, title default,
  and R2 file-building logic require no changes — only a new parser front end.
- **1 MB guard** is generous for a personal-publisher text paste but far below the ~95 MB multipart
  guard and the 128 MB Worker memory limit, mitigating memory abuse risk (R19).
- **Create-only** defers the replace-on-edit question to a follow-up; the UI therefore exposes the
  paste flow only on the upload page, not the edit page.
- **No new runtime dependencies**; the paste path reuses the existing `marked` Markdown rendering.
- **Trust model** for pasted Markdown raw HTML is identical to multipart uploads: governed by the
  existing `allowRawHtmlInMd` flag (default true), single-operator scope.

## Cross-references

- Code: `src/form-parser.ts` (`parsePublishJson`), `src/admin-api.ts` (`handleCreatePage` branch),
  `src/admin-ui.ts` (paste tab on `/admin/upload`).
- Tests: `test/admin-api-paste.test.ts`, `test/form-parser.test.ts`, `test/admin-ui.test.ts`.
- Docs: `docs/api/admin-api.md`, `docs/architecture/05-error-handling.md`,
  `docs/operations/smoke-test-checklist.md`, `docs/development/roadmap.md`.
