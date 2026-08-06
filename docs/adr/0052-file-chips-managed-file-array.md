# 0052: S8 file chips below dropzone with managed file array and remove capability

- Status: accepted
- Date: 2026-08-04

## Context

Slice 6 (ADR 0049) added styled dropzones with drag-and-drop support, but the upload page had no
visual feedback when files were selected. Users dragging files or clicking to browse saw nothing
change on the page — no indication of what was chosen. Additionally, the `FileList` objects from
`<input>.files` and `DataTransfer.files` are **immutable**: individual files cannot be removed
before submit.

## Decision

### 1. Replace `selectedFiles()` with a managed file array

A module-scoped `managedFiles` array holds `{ file: File, path: string }` objects. Instead of
reading directly from `filesInput.files` and `folderInput.files` at submit time, the inline script
maintains this array and `selectedFiles()` returns it:

- When files are added (via `change` event on either input, or via drop), `syncManagedFiles()`
  rebuilds the array from both inputs, deduplicating by path.
- When a file is removed (via chip X button), `managedFiles.splice(idx, 1)` removes it and the
  entry picker is re-evaluated.
- The paste-tab guards (`files.length === 0` / `files.length > 0`) work unchanged against the
  array's `length`.

### 2. Chip UI below each dropzone

A `.file-chips` container sits after each dropzone. `renderChips()` renders file chips showing:

- A 16×16 file-type icon (`#icon-file`, `#icon-file-html`, `#icon-file-markdown`, `#icon-file-image`)
  based on extension — reusing the same heuristic as `fileKindIcon()` on the edit page.
- The file path (escaped via `escapeHtml()`).
- A red X remove button (`#icon-trash`, 14×14) that calls `managedFiles.splice()` and re-renders.

Each chip-remove button uses `data-chip-index` to identify its position. Since `splice()` shifts
indices, the chips container is fully re-rendered after every removal — this is safe and avoids
index-tracking bugs at the cost of a small DOM update on a user-triggered action.

### 3. `escapeHtml` for file paths in chips

A local `escapeHtml()` function (same pattern as the server-side `escapeHtml` from `src/utils.ts`)
ensures file paths containing HTML-special characters are safely rendered.

### 4. Form submission uses managed array

The submit handler iterates `managedFiles.forEach(function(item) { formData.append('file:' + item.path, item.file, item.path); })` instead of reading from `filesInput.files` or calling `relative()`.

### 5. `updateEntryPicker()` adapted for managed entries

Since `selectedFiles()` now returns `{ file, path }` objects rather than `File` objects,
`updateEntryPicker()` reads `f.path` instead of calling `f.webkitRelativePath || f.name`.

## Consequences

- **Visual feedback**: users immediately see selected files as chips with type icons.
- **Removable files**: users can remove individual files without clearing the entire selection.
- **No regressions**: all existing dropzone styling, drag/drop handlers, folder toggle, paste tab,
  and mutual-exclusion guards continue to work.
- **Slightly larger inline JS**: the IIFE grows by ~60 lines (managed array, `renderChips`,
  `syncManagedFiles`, `escapeHtml`, updated `updateEntryPicker`, updated form submit) but remains
  well within the Worker bundle limit.
- **No new runtime dependencies**: the chip UI is pure HTML/CSS/JS with existing SVG sprite icons.
- **No build step changes**.

## Cross-references

- ADRs: 0028 (S19 admin UI), 0039 (T3 buildless overhaul), 0049 (S6 dropzone upload UI), 0047
  (SVG icon sprite).
- Docs: `docs/api/admin-ui.md` (upload page section — updated).
- Code: `src/admin-ui.ts` — `uploadContent()`, `DESIGN_SYSTEM_CSS`.
