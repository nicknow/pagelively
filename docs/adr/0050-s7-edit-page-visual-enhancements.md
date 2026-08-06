# 0050: S7 edit page visual enhancements — kind icons, lock icon, kind badge icon

- Status: accepted
- Date: 2026-08-04

## Context

Slice 7 adds visual iconography to the edit page (`editContent()` in `src/admin-ui.ts`) to
match the dashboard visual enhancements introduced in S5. Three specific enhancements were
needed:

1. File rows in the file list should show a kind icon (20×20) based on file extension,
   matching the pattern established for kind badges on the dashboard (S5, ADR 0039 / ADR 0046).
2. The "Protected" badge on entry-file rows should include a lock icon (14×14) to visually
   distinguish protected files from deletable ones.
3. The kind badge in the page header (`<h2>`) should show the same 16×16 kind icon that the
   dashboard kind badges display (S5).

The implementation must not alter any existing behavior: delete buttons, protected-file guard,
password handling, add-files form, and the protected hint must all remain unchanged.

## Decision

Three changes were made to `editContent()` in `src/admin-ui.ts`:

1. **File kind icon helper** (`fileKindIcon`): A standalone function that maps file extensions
   to icon sprite references using the same logic as S5's dashboard kind badges:
   - `.html`, `.htm` → `#icon-file-html`
   - `.md`, `.markdown` → `#icon-file-markdown`
   - `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.avif` → `#icon-file-image`
   - Everything else → `#icon-file`

   The resulting SVG (`<svg class="icon" width="20" height="20" aria-hidden="true">`) is
   prepended before `<code class="file-path">` in each `.file-row`.

2. **Page kind icon helper** (`pageKindIcon`): A standalone function that maps the page kind
   field to an icon, using the same `kindIconMap` as `dashboardContent()`:
   - `html` → `file-html`
   - `markdown` → `file-markdown`
   - `image` → `file-image`
   - `bundle` → `file-bundle`
   - Unknown kinds → `file` (generic)

   The resulting SVG (`<svg class="icon" width="16" height="16" aria-hidden="true">`) is
   prepended before the kind text inside the header `.badge kind-*` span.

3. **Lock icon on protected badge**: The existing `<span class="badge protected">Protected</span>`
   is replaced with a version that prepends a lock icon:
   `<svg class="icon" width="14" height="14" aria-hidden="true"><use href="#icon-lock"></use></svg>`

   The `#icon-lock` symbol was already defined in the SVG sprite from S2 (ADR 0047).

### Alternatives considered

- **Inline switch vs. helper function**: An inline switch was simpler but the helper function
  improves readability and is consistent with the project's modular style.
- **Reusing `dashboardContent`'s icon logic**: Since `dashboardContent` uses the same mapping
  but with different icon sizes (16×16 for dashboard badges vs 20×20 for file rows), a separate
  function with configurable size was considered but rejected as unnecessary complexity — the
  two contexts need different sizes and the duplication is minimal.

## Consequences

- File rows now have consistent visual signing by file type, matching the dashboard's badge
  icons and improving scannability.
- Protected files are visually distinguished by the lock icon, making the UI more intuitive.
- The header kind badge now matches the dashboard's visual treatment, providing consistency
  across the admin UI.
- No new SVG sprite symbols were needed; all icons already existed from S2 (ADR 0047).
- All existing edit page behavior is preserved — tests explicitly verify that delete buttons,
  protected-file guards, password handling, and add-files forms remain unaltered.
