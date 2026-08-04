# 0051: Password prompt CSS polish — centered card, admin-palette matching

- Status: accepted
- Date: 2026-08-04

## Context

Slice 9 polishes the password prompt page (`src/password-prompt.ts`) visual presentation.
S23-A shipped with minimal styling (bare system font, basic spacing, `#b00020` error color).
The admin UI (T3, ADR 0039) and its subsequent CSS token work (ADR 0046) established a
light/dark palette with specific hex values, but those tokens live in `admin-ui.ts` and use
CSS custom properties (`--color-*`), which is a dependency the password prompt must not
share — ADR 0041 decision 5 mandates zero external resources and full inline self-containment.

The password prompt needs visual parity with the admin UI's look and feel while remaining
a fully standalone inline HTML document with no shared variables, no CDN, no external CSS,
and no admin-UI imports.

## Decision

1. **Hardcode the admin UI light palette hex values** directly in the inline `<style>` block.
   Every value is a literal; there are no `var()` references, no shared constants, and no
   imports from `admin-ui.ts`. The mapping:

   | CSS selector                   | Property        | Hex value          | Admin UI token          |
   | ------------------------------ | --------------- | ------------------ | ----------------------- |
   | `body`                         | `background`    | `#f8fafc`          | `--color-bg`            |
   | `main`                         | `background`    | `#ffffff`          | card surface            |
   | `main`                         | `border-radius` | `0.75rem`          | matches admin card      |
   | `main`                         | `box-shadow`    | multi-layer shadow | matches admin card      |
   | `button`                       | `background`    | `#2563eb`          | `--color-primary`       |
   | `button:hover`                 | `background`    | `#1d4ed8`          | `--color-primary-hover` |
   | `input[type="password"]`       | `border-color`  | `#e2e8f0`          | admin input border      |
   | `input[type="password"]:focus` | `border-color`  | `#3b82f6`          | admin focus ring        |
   | `.error`                       | `color`         | `#dc2626`          | `--color-danger`        |
   | `.error`                       | `background`    | `#fef2f2`          | `--color-danger-bg`     |

2. **Add an extended font stack** matching the admin UI: `system-ui, -apple-system,
BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`.
   This improves cross-platform font rendering without adding any external resource.

3. **Include an optional `@media (prefers-color-scheme: dark)` block** with hardcoded dark
   palette hex values from the admin UI dark theme (ADR 0046):

   | Element        | Property       | Light     | Dark                   |
   | -------------- | -------------- | --------- | ---------------------- |
   | `body`         | `background`   | `#f8fafc` | `#0b1220`              |
   | `main`         | `background`   | `#ffffff` | `#16213a`              |
   | `body`         | `color`        | `#0f172a` | `#f1f5f9`              |
   | `p`            | `color`        | `#64748b` | `#94a3b8`              |
   | `input`        | `border-color` | `#e2e8f0` | `#2b3a55`              |
   | `button`       | `background`   | `#2563eb` | `#3b82f6`              |
   | `button:hover` | `background`   | `#1d4ed8` | `#60a5fa`              |
   | `.error`       | `color`        | `#dc2626` | `#f87171`              |
   | `.error`       | `background`   | `#fef2f2` | `rgba(220,38,38,0.18)` |

4. **Preserve all structural constraints** from ADR 0041 decisions 5 & 7:
   - HTML structure (`h1`, `p`, `form`, `input`, `button`) is untouched.
   - Form action, form method, password `required`/`minlength="5"`, and submit button are
     unchanged.
   - All escaping behavior (`escapeHtml`) is unchanged.
   - No external resources (`<link>`, `<script>`, `url()`, `@import`, `src`/`href` to
     `http(s):`).
   - No page title leak or content slot added.

## Consequences

- The password prompt now visually matches the admin UI's light and dark themes, providing a
  consistent user experience across the application.
- The `@media (prefers-color-scheme: dark)` block is an additive enhancement — browsers that
  do not support it (or users without the preference set) see only the light theme. No
  breakage risk.
- The dark mode block is all on one line within the `<style>` tag — no CSS file count change,
  no external resource.
- The file stays fully self-contained: no imports from `admin-ui.ts`, no shared CSS variables,
  no CDN references.
- Bundle size impact: negligible (CSS grew from ~220 bytes to ~1,430 bytes, still well under
  the Worker bundle budget).

## Cross-references

- ADR 0041 (S23 — password-protected pages) decisions 5 & 7 (inline, no external resources).
- ADR 0042 (S23-A — password primitives) — `password-prompt.ts` as a pure module.
- ADR 0045 (admin UI CDN resource policy) — explicitly excludes `password-prompt.ts`.
- ADR 0046 (CSS design tokens — dark palette) — sourced the dark palette hex values.
