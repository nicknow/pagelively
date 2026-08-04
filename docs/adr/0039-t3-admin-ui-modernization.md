# 0039: T3 admin UI modernization — buildless overhaul

- Status: accepted (amended by 0045)
- Date: 2026-08-02

## Context

The admin UI (S19, ADR 0028) was functional but minimal: a short inline CSS block, basic table
layout, and blocking `alert()` calls for delete errors. The product spec (§10, §14) and the
bundle-size constraint (§15, risk R5) require the UI to stay buildless and dependency-free.

Open question OQ-18 asked whether to modernize with a framework/SPA or a buildless overhaul. The
buildless option keeps the Worker self-contained, avoids a build step, and leaves the door open
for a framework later if the UI grows.

## Decision

### 1. Option A — buildless overhaul

All modernization work stays in `src/admin-ui.ts`. No new runtime dependencies, no external CDN,
no framework, no build step. The CSS is refactored into a large design-system string built on CSS
custom properties (`:root { --color-bg: ...; --radius: ...; }`). The inline JS is organized into
shared helpers (`showToast`, `updateSlugPreview`, `initSlugPreview`).

- **Trade-off:** the file is larger than the original S19, but the dry-run build still fits well
  within the Workers Free tier (≈168 KiB raw / ≈39 KiB gzip after T3, limit 3 MB compressed).
- **Security:** dynamic values remain HTML-escaped through `escapeHtml` before interpolation; no
  new injection surface is introduced.

### 2. Design-system summary

- Light theme only. Dark mode is explicitly deferred (not needed for the current operator UX and
  keeps the first overhaul small).
- CSS custom properties for palette, spacing, radii, shadows, and typography.
- Responsive layout: dashboard table switches to stacked cards on mobile; form controls stack;
  tabs stay usable.
- Focus-visible outlines and accessible labels/roles on tabs and form controls.
- No inline `style="..."` attributes in the server-rendered HTML; all styling is class-based.

### 3. UX changes

- **Dashboard:** kind and visibility badges, a clear empty state, and a prominent Upload button.
- **Upload page:** two distinct tabs (Upload files / Paste content), shared error box, clearer
  file/folder picker labels and hints.
- **Edit page:** metadata card, file list with file-kind badges and a **Protected** badge on
  entry files, separate add-files card.
- **Toast notifications:** a fixed `#toast-container` shows non-blocking toasts. Delete handlers
  (dashboard, file delete, page delete) surface API errors via `showToast(...)` instead of
  `alert(...)`. `confirm()` is retained for destructive-action confirmation.
- **Inline slug preview:** a small JS function mirrors the client-facing part of `cleanSlug`
  (trim, lowercase, collapse spaces/non-alphanumerics to dashes, trim edge dashes) and shows a
  preview like `URL: /my-page/`. This is UX polish, not a replacement for server-side validation.

### 4. T1/T2/T4 functionality preserved

The multipart upload convention, paste-content JSON path, protected-entry-file behavior, and
error-message precedence (`message` over `error` code) are unchanged. Only the presentation layer
was updated.

## Consequences

- The UI remains buildless and dependency-free, satisfying the spec and the bundle-size gate.
- The presentation is easier to scan and operate on mobile and desktop.
- Future theming (e.g., dark mode) can be added by extending the CSS custom properties and a small
  `data-theme` toggle; no structural change to the HTML/JS is needed.
- A future framework/SPA migration is still possible if the admin UI grows, but it is not needed
  for v1.

## Cross-references

- Spec: §5 (URL scheme), §9 (auth), §10 (admin UI & upload flows), §14 (toolchain), §15 (bundle size).
- Docs: `docs/api/admin-ui.md`, `docs/operations/smoke-test-checklist.md`, `docs/development/roadmap.md`.
- ADRs: 0028 (S19 admin UI), 0036 (T1 slug cleaning/error messages), 0027 (T2 protected entry files), 0038 (T4 paste content).
- Code: `src/admin-ui.ts`.
