# 0027: S18 edit & delete API — file-delete rev bump + entry-file protection

- Status: accepted
- Date: 2026-08-01

## Context

Slice S18 implements the edit and delete surface of the admin API:

- `PATCH /api/pages/:id` — metadata edits (slug, title, visibility, show_source)
- `POST /api/pages/:id/files` — add or replace files
- `DELETE /api/pages/:id/files/:path` — remove a file
- `DELETE /api/pages/:id` — delete a page and all its objects

Two concrete decisions were not fully fixed by earlier ADRs:

1. **File delete rev bump.** ADR 0012/OQ-04 already says content-affecting actions bump
   `rev`: file-add, file-delete, entry-change, re-render. `file-delete` is listed as bumping,
   but the implementation mechanics (copying the remaining files to a fresh rev folder) needed
   to be pinned.
2. **Entry file protection.** The entry file is the page root: the served `index.html` for
   markdown pages, the original HTML path for `html` pages and bundle pages with an HTML entry,
   or the image filename for image pages. Deleting it would leave the page with no served entry.
   The API must reject the request.

Also, `PATCH` of `show_source` on a Markdown page changes the rendered entry HTML (the
`source.md` link is toggled), but ADR 0012 classifies `show_source` changes as a metadata
edit (no rev bump). This slice therefore re-renders the entry HTML in place at the same rev
and relies on the cache purge for freshness.

## Decision

### 1. File-delete bumps the rev and copies the remaining files

Per ADR 0012, `file-delete` is a content-affecting action. We do **not** mutate the existing rev
folder in place (ADR 0012 d5: "no page with `rev > 0` is mutated in place"). Instead:

1. Compute `newRev = nextRev(page.rev)`.
2. Read every remaining file from the old rev folder via `objectStore.get`.
3. Write each remaining file to `pages/{id}/{newRev}/{path}`.
4. Update `pages.rev`, `pages.updated_at`, and the `files` rows via `applyRevBump` + `replaceAll`.
5. Purge the page's `Cache-Tag`.

The old rev folder is left for garbage collection (OQ-10 deferred; no GC in v1).

This is the same pattern used for `POST /api/pages/:id/files` (add/replace), which also bumps
rev and rewrites all files to the new folder.

### 2. Entry file cannot be deleted

The deletion check is based on the _served_ entry path and any raw Markdown source that renders
into it:

- For `image` pages the entry is the stored image filename in `pages.entry_path`.
- For `markdown` pages and `bundle` pages with a Markdown entry (`raw_md_path !== null`), the
  served entry is `index.html` and the raw source stored at `pages.raw_md_path` (always
  `source.md` in v1) is also protected.
- For `html` pages and `bundle` pages with an HTML entry (`raw_md_path === null`), the served
  entry is the original HTML path stored in `pages.entry_path` (e.g., `site/index.html` for a
  nested bundle entry).

Any `DELETE .../:path` matching one of these protected paths returns
`400 { error: "entry_not_deletable" }`. The error message is now actionable and names the
protected path(s): for rendered pages it says "The rendered page files (index.html and
source.md) are part of the page and cannot be deleted individually. Delete the page to
remove it."; for an image page it names the image file. The JSON body stays the same
`{ error: "entry_not_deletable" }` shape so existing clients do not need to change. The
whole page is removed with `DELETE /api/pages/:id`.

The entry file **can** be replaced via `POST /api/pages/:id/files` (e.g., upload a new
`index.html` for an HTML page, or a new `.md` matching the bundle Markdown entry that
re-renders into `index.html`). This is the supported path for changing entry content.

### 3. Metadata edits do not bump rev

`PATCH` updates only `pages.slug`, `pages.title`, `pages.visibility`, and `pages.show_source`.
None of these change the byte content of a rev (the slug appears only in the URL path, not in
stored objects; the title/visibility are metadata-only; `show_source` for Markdown toggles the
rendered entry HTML, but the spec calls it a metadata edit and ADR 0012 explicitly lists
`meta-edit` as non-bumping).

For Markdown pages, toggling `show_source` re-renders `index.html` at the **current** rev from
`source.md` and overwrites the stored entry. Cache purge covers freshness. If the D1 update fails
after the R2 overwrite, the old rendered `index.html` is restored best-effort.

### 4. Page delete removes D1 rows and all R2 objects

`DELETE /api/pages/:id`:

1. Looks up the page (404 if missing).
2. Deletes the `pages` row (cascade deletes `files` rows via the foreign key).
3. Deletes every R2 object under `pages/{id}/` via `objectStore.deletePageObjects`.
4. Purges the page's cache tag.
5. Returns `204 No Content`.

### 5. Rollback of partial writes

For `POST /api/pages/:id/files` and `DELETE /api/pages/:id/files/:path`, R2 objects are written
to the new rev folder first, then D1 is updated. If D1 fails, the new rev folder is deleted via
`objectStore.deletePageRevObjects(id, newRev)` before the error is re-thrown. If the page rev bump
succeeded before the file-row replacement failed, the handler also restores the previous page row
and `files` rows so the page remains consistent with the untouched old rev folder. The old rev
folder remains authoritative and untouched.

## Consequences

- Every content-affecting edit (file add/replace/delete) creates a fresh rev folder, preserving
  the immutable-by-URL property for CDN-served assets (ADR 0012, ADR 0006).
- File delete is more expensive than a single delete, but it keeps the rev model uniform and the
  `files` table consistent with the actual object layout.
- Entry deletion is a client error (400), not a 404, because the path exists but the operation is
  disallowed.
- Metadata edits stay cheap: no object copy, only a D1 row update + cache purge.
- The `show_source` toggle requires a Markdown re-render, but avoids a rev bump per ADR 0012.

## Cross-references

- Spec: §5 (admin API surface), §7 (Markdown rendering), §8 (storage schema), §10 (edit/delete flows), §11 (cache purge).
- Docs: `docs/api/admin-api.md`, `docs/operations/smoke-test-checklist.md`.
- ADRs: 0012 (rev policy, `RevAction` union), 0014 (Markdown rendering), 0026 (S17 upload API).
- Code: `src/admin-api.ts`, `src/pages-repository.ts`, `src/files-repository.ts`, `src/object-store.ts`, `src/form-parser.ts`, `src/index.ts`.
