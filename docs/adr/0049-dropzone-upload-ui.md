# 0049: S6 dropzone upload UI — drag-and-drop file upload with styled dropzones

- Status: accepted
- Date: 2026-08-04

## Context

Slice 6 converted the native `<input type="file">` pickers on the upload page into styled
dropzones with drag-and-drop support. The goals were:

1. **Visual clarity**: make the file upload area visually distinct and inviting, guiding the user
   toward the natural action of dragging files or clicking to browse.
2. **Touch-friendly**: the click-to-browse flow must still work on touch devices. This is
   achieved by layering the transparent native `<input>` over the dropzone content rather than
   using a separate click handler.
3. **Drag-and-drop**: accept files dragged from the desktop, assign them programmatically to the
   input via `DataTransfer`, and re-run the entry picker so the UX is identical to browsing.
4. **Folder upload as opt-in**: the folder `webkitdirectory` picker is hidden behind a small
   toggle link to reduce visual clutter (most uploads are loose files).

## Decision

### 1. Layer the native `<input>` over the dropzone

Each file input (`#files`, `#folder`) is rendered inside a `.dropzone` container with
`position: relative`. The input element itself is styled `position: absolute; inset: 0;
opacity: 0; cursor: pointer`, so clicking anywhere on the dropzone triggers the OS file picker.
This preserves the native browser behavior (accessible, touch-compatible, works with assistive
technology) while letting the dropzone div carry the visual design.

### 2. Drag-and-drop handlers on the dropzone

Three event handlers on each dropzone div:

- `dragover` — prevent default (required to allow drop), add `.drag-active` class for visual
  feedback.
- `dragleave` — remove `.drag-active`.
- `drop` — prevent default, remove `.drag-active`, create a `DataTransfer` from the dropped
  `FileList`, assign it to the hidden input's `files` property, and call `updateEntryPicker()`
  so the entry selector reflects the new selection.

This avoids any global drag handlers — each dropzone is independent, and the loose-files and
folder dropzones handle their own drops.

### 3. Folder upload is hidden behind a toggle

Only the loose-files dropzone is visible by default. A small "Uploading a folder instead?"
button toggles a `.folder-dropzone-wrapper` between `display: none` (default) and
`display: block` (via `.visible` class). The toggle button text changes to "Hide folder upload"
when the folder zone is shown.

This preserves the ADR 0028 two-picker split (required because `webkitdirectory` and `multiple`
on the same input forces directory-only selection) while reducing visual noise.

### 4. CSS for dropzone states

All styles use the existing design-token variables (`--color-border`, `--color-primary`,
`--color-primary-bg`, `--color-text-muted`, `--radius-lg`, `--space-8`, `--transition-fast`).
The `.dropzone.drag-active` state mirrors `.dropzone:hover`, giving consistent feedback whether
the user hovers or drags over the zone.

### 5. Edit page is NOT affected

Only `uploadContent()` was changed. The edit page's "Add / replace files" card retains the
native inputs (no dropzones) — the same two-picker split but without the visual wrapping. This
is intentional: the add-files flow on the edit page is a secondary action used less frequently.

## Consequences

- The upload page is visually clearer and more inviting.
- Drag-and-drop works without any external library or CDN dependency.
- The native input remains fully functional (click-to-browse, touch, assistive tech).
- No new runtime dependencies or build steps.
- The two-picker split (ADR 0028) is preserved and now visually cued: the folder picker is
  hidden behind an explicit toggle.
- The inline JS grows slightly (~20 lines for `initDropzone` + folder toggle wiring) but
  remains well within the Worker bundle limit.
- Touch-device users get the same click-to-browse experience as before (the layered input
  handles taps).

## Cross-references

- ADRs: 0028 (S19 admin UI — original two-picker split), 0039 (T3 buildless overhaul), 0046
  (CSS design tokens), 0047 (SVG icon sprite).
- Docs: `docs/api/admin-ui.md` (upload page section).
- Code: `src/admin-ui.ts` — `uploadContent()` and `DESIGN_SYSTEM_CSS`.
