# 0046: CSS design tokens — dark palette, reduced motion, transition tokens

- Status: accepted
- Date: 2026-08-04

## Context

The admin UI (T3, ADR 0039) shipped with a light-only theme and no motion-preference handling.
The product spec §10 and §14 require WCAG AA minimum contrast and inclusive UX. Users who work
in low-light environments or have motion sensitivities need proper support.

Additionally, several transitions used ad hoc `0.15s ease` literals scattered across three rules
(button, input/textarea/select, tab), making systematic timing changes fragile and inconsistent.

## Decision

### 1. Dark palette

Add a complete dark palette using CSS custom properties, following the mechanism described in the
design brief:

- **`:root`** — explicit `color-scheme: light` and the existing light tokens (no breaking change).
- **`@media (prefers-color-scheme: dark)`** — wraps `:root:not([data-theme="light"])` so the OS
  preference is honored unless the user explicitly overrides to light.
- **`:root[data-theme="dark"]`** — explicit opt-in override for a toggle JS (implemented in ADR 0048, Slice 3).
- **`:root[data-theme="light"]`** — explicit override that re-declares all light tokens, ensuring
  a toggle works reliably even under `prefers-color-scheme: dark`.

Dark values from the design brief were verified for WCAG AA contrast against the dark background:

| Token                    | Light value | Dark value              |
| ------------------------ | ----------- | ----------------------- |
| `--color-bg`             | `#f8fafc`   | `#0b1220`               |
| `--color-surface`        | `#ffffff`   | `#16213a`               |
| `--color-surface-raised` | `#f1f5f9`   | `#1e293b`               |
| `--color-text`           | `#0f172a`   | `#f1f5f9`               |
| `--color-text-muted`     | `#64748b`   | `#94a3b8`               |
| `--color-primary`        | `#2563eb`   | `#3b82f6`               |
| `--color-primary-hover`  | `#1d4ed8`   | `#60a5fa`               |
| `--color-primary-bg`     | `#eff6ff`   | `rgba(59,130,246,0.16)` |
| `--color-danger`         | `#dc2626`   | `#f87171`               |
| `--color-danger-hover`   | `#b91c1c`   | `#fca5a5`               |
| `--color-danger-bg`      | `#fef2f2`   | `rgba(220,38,38,0.18)`  |
| `--color-success`        | `#16a34a`   | `#4ade80`               |
| `--color-warning`        | `#ca8a04`   | `#facc15`               |
| `--color-border`         | `#e2e8f0`   | `#2b3a55`               |
| `--color-focus`          | `#3b82f6`   | `#60a5fa`               |
| `--shadow-sm`            | .../0.05    | .../0.3                 |
| `--shadow-md`            | .../0.1     | .../0.4                 |
| `--shadow-lg`            | .../0.1     | .../0.5                 |

### 2. Badge dark-mode overrides

Badge classes (`.kind-*`, `.visibility-*`, `.protected`) use hardcoded light-optimized colors.
Dark-mode overrides use translucent backgrounds with lighter text, wrapped in the same
`@media (prefers-color-scheme: dark)` + `:root[data-theme="dark"]` pattern as the core tokens.

### 3. Transition tokens

Two new custom properties:

- `--transition-fast: 0.15s ease` — for button, input, and tab hover/focus transitions.
- `--transition-base: 0.2s ease` — reserved for broader UI transitions (toast, card, future).

All three ad hoc `0.15s ease` literals were replaced with `var(--transition-fast)`.

### 4. Reduced motion

A `@media (prefers-reduced-motion: reduce)` block zeroes out animation and transition durations
on all elements with `!important`, following the standard accessibility pattern.

## Consequences

- Light theme is unchanged; all existing tests pass without modification.
- Dark mode is automatically applied for users with `prefers-color-scheme: dark` and can be
  toggled via the JS toggle button in the header (ADR 0048, Slice 3).
- Motion-sensitive users are respected out of the box.
- Transition timing is now centrally controlled via custom properties; changing the base speed
  updates all themed transitions at once.
- The CSS string grew by about 1.5 KiB raw, well within the Workers Free tier budget.
- Preserved all existing tokens (no breaking changes).

## Cross-references

- Spec: §10 (admin UI), §14 (toolchain), §15 (bundle size).
- ADRs: 0039 (T3 admin UI modernization), 0028 (S19 admin UI).
- Code: `src/admin-ui.ts`, `test/admin-ui.test.ts`.
