# ADR 0047: Inline SVG Icon Sprite for Admin UI

- Status: accepted

## Context

The admin UI needs consistent, lightweight icons throughout the dashboard, upload, and
edit views. The requirements:

- No external dependencies (no icon libraries, no CDN requests)
- Must remain within Workers free-tier code size limits
- All icons must be static string literals (no dynamic/request-derived data interpolated
  into SVG markup)
- Icons must use Feather/Lucide-style outline design with `stroke="currentColor"` for
  easy dark/light mode adaptation

## Decision

We ship a single inline SVG sprite containing 17 `<symbol>` definitions and a small CSS
utility class `.icon`. Specifically:

1. **Sprite placement**: The `<svg style="display:none" aria-hidden="true">` element is
   placed just before `</body>` in the `layout()` function template. This is the standard
   SVG sprite pattern — hidden from visual rendering and screen readers, but available
   for `<use>` references anywhere in the page.

2. **Icon design**: Each icon uses Feather/Lucide-compatible attributes:
   `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`,
   `stroke-width="1.75"`, `stroke-linecap="round"`, `stroke-linejoin="round"`.

3. **CSS utility**: The `.icon` class sets `vertical-align: middle; flex-shrink: 0;`.
   Width/height are controlled by inline attributes on each `<svg class="icon">`
   usage instance.

4. **Toast integration**: `showToast(message, type)` uses
   `document.createElementNS('http://www.w3.org/2000/svg', ...)` to create the icon
   element — no innerHTML injection, fully XSS-safe. The message text is appended via
   `textContent`. Type `'success'` uses `#icon-check-circle`; all other types (including
   the default `'error'`) use `#icon-alert-circle`.

5. **File variants**: The `file-html`, `file-markdown`, `file-image`, and `file-bundle`
   icons reuse the standard file document outline plus small distinguishing marks
   (chevrons, M↓, mountain, layered boxes) to keep them legible at small sizes.

## Consequences

### Positive

- Zero external icon dependencies; all icons are bundled in the Worker code
- Icons automatically adapt to light/dark mode via `currentColor`
- `<use>` pattern allows consistent icon sizes per usage context (16px, 18px, 20px, etc.)
- No new escaping surface — all SVG content is static string literals

### Negative

- Adding or changing icons requires editing the TypeScript source
- The sprite adds ~4.5KB to every HTML page served by the admin UI
- File-variant icons (`file-html`, etc.) are simplified representations that may not
  be perfectly recognizable at very small sizes

## Alternatives Considered

- **External icon CDN**: Rejected — violates Workers zero-external-dependency constraint
  and adds a network request.
- **Inline `<svg>` per usage**: Rejected — far more verbose and harder to maintain than
  the sprite pattern.
- **Data-URI icons in CSS**: Rejected — harder to maintain, no easy `currentColor`
  support without more complex CSS.
