# 0048: Dark mode toggle — early inline script + toggle behavior + header button

- Status: accepted
- Date: 2026-08-04

## Context

ADR 0046 implemented a complete dark palette via CSS custom properties with both
`prefers-color-scheme` media query support and explicit `:root[data-theme="dark"]` /
`:root[data-theme="light"]` overrides. However, it deferred the JS toggle to a "future
Slice 7".

To eliminate flash-of-unstyled-content (FOUC) on reload in dark mode, the toggle must be
applied synchronously before the browser renders the page. A toggle button in the header
lets the operator switch themes interactively, with the preference persisted in
`localStorage`.

## Decision

### 1. Early inline script (no-FOUC)

A tiny synchronous `<script>` is placed immediately after `<meta name="viewport">` and before
the `<style>` block in the layout template. It reads `localStorage.getItem('pl-theme')` and,
if the value is `'light'` or `'dark'`, sets `document.documentElement.setAttribute('data-theme',
value)`. If no stored preference exists, it does nothing — the CSS media query
`@media (prefers-color-scheme: dark)` handles the default.

This placement ensures the `data-theme` attribute is set on `<html>` before the CSS is parsed
and applied, preventing any FOUC on page load.

The script is intentionally **not** part of `SHARED_JS`, which comes after `<style>` and would
be too late — the browser would paint with the wrong theme before the JS runs.

### 2. Toggle behavior in `SHARED_JS`

A `toggleTheme()` function computes the current effective theme (checking
`data-theme` attribute first, then the `prefers-color-scheme` media query), flips it, sets
the `data-theme` attribute on `<html>`, and writes the preference to `localStorage`. It also
updates all toggle buttons' `aria-pressed` state and swaps the icon to show the mode the user
would switch _to_.

A `DOMContentLoaded` listener wires the toggle button via a `data-theme-toggle` attribute
(rather than an `id`), avoiding coupling to a specific element ID. It initialises the button's
`aria-pressed` state and icon to match the current effective theme.

### 3. Toggle button in the header

An icon-only `<button>` is placed in the `.header-inner` div of the layout, to the right of the
email identity span. It uses:

- `data-theme-toggle` attribute for the event listener
- `class="button button-small"` for consistent styling
- `aria-label="Toggle color theme"` for accessibility
- `aria-pressed` reflecting whether dark mode is active
- `style="width:44px;height:44px"` for a minimum 44×44 CSS pixel tap target (WCAG 2.5.8)
- A `<use href="#icon-sun">` SVG icon (shows the mode you'd switch to when in dark mode)

### 4. Header layout adjustments

The `.header-inner` rule was split from `.container` (both shared `max-width`, `margin`, and
`padding`) to add `display: flex; align-items: center; justify-content: space-between;` for
horizontal layout. The email identity span gets `text-overflow: ellipsis; overflow: hidden;
white-space: nowrap; max-width: 200px;` to prevent awkward wrapping at narrow widths.

## Consequences

- **No FOUC**: the early inline script runs before the CSS paints, so the correct theme is
  always applied on first render.
- **Persistent preference**: the user's choice survives page reloads via `localStorage`.
- **OS-level default**: when no preference is stored, `prefers-color-scheme` media query
  determines the theme.
- **Accessible**: the button has `aria-label`, `aria-pressed`, and a 44×44 px tap target.
- **Decoupled wiring**: the event listener uses `data-theme-toggle` attribute instead of an ID,
  allowing multiple toggle buttons in the future.
- The layout is now 74 bytes larger (inline script), and `SHARED_JS` grew by ~900 bytes
  (toggle logic), still well within the Workers Free tier budget.

## Cross-references

- Spec: §10 (admin UI), §14 (toolchain), §15 (bundle size).
- ADRs: 0046 (CSS design tokens — dark palette), 0047 (inline SVG icon sprite), 0039 (T3 admin
  UI modernization), 0028 (S19 admin UI).
- Code: `src/admin-ui.ts`, `test/admin-ui.test.ts`.
