# 0008: Serve-time `<base>` injection

- Status: accepted
- Date: 2026-07-31

## Context

The spec (§14) requires the Worker to inject a `<base>` tag into served HTML so that relative
asset URLs resolve correctly from slug paths (`/{slug}/`) and id paths (`/p/{id}/`); §13 also
mandates that assets work from any of the three environments (preview/assigned/r2.dev-derived
base URLs). The roadmap (§8) asks for an ADR on the serve-time injection. Open question in the
deliverable: whether `ASSET_BASE_URL` is used at **build time** (stamped into stored HTML) or
at **serve time** (injected per request).

## Decision

1. **Serve-time, uniform injection** (S04): every served HTML page for an entry gets its
   `<base>` injected **at request time** from the row's `ASSET_BASE_URL`, inside the `<head>`
   (right after `<head>`, or prepended if absent — injected before serving, never persisted).
   The same code path serves both `/{slug}/` and `/p/{id}/`, so relative asset references
   resolve identically from either URL (spec §13's requirement).
2. **`ASSET_BASE_URL` at build time is rejected** (the alternative): storing a base into the
   HTML would bake one environment into content and break §13's "assets work from any of the
   three environments" — a stored URL cannot serve preview _and_ assigned and r2.dev-derived
   bases simultaneously.
3. **Base value**: exactly `ASSET_BASE_URL` as configured (trailing slash normalized to the
   form used in `docs/architecture/02`'s `AppConfig`); no path prefixes, no query strings
   allowed (config validation at boot, fail-fast per ADR 0001).
4. **Injection safety**: pure function over `(html, baseUrl)` — string-level insertion into
   `<head>` only (the template always has `<head>`); ~~`html` with no `<head>` → error 500 at
   render time (rendered pages always come from the bundled template; §7), never silent
   output~~. **Amended by ADR 0013:** `html` with no `<head>` gets one **created** containing
   the base — the function never throws on any input (roadmap S04 AC: "unparseable/empty
   HTML: still returns a document containing the base"; `html`-kind pages are user-uploaded
   arbitrary fragments, §4, and a 500 there would make valid pages unservable). Escaping: base
   value is config-controlled (operator-owned), but the injected attribute is HTML-escaped
   anyway (defense in depth; risk R12).
5. **Markdown-sourced pages (§7) get the same base** — the markdown pipeline runs before
   injection, so raw-HTML content (when allowed) cannot smuggle a `<base>`: injection replaces
   any existing `<base>` **anywhere in the document** (ADR 0013 decision 4 — every well-formed
   `<base>` opening tag in scanned markup is removed, case-insensitively, so exactly one active
   base remains; tested, S04 AC).

## Consequences

- Relative assets work from both URL shapes and all three environment base URLs, per §13/§14,
  with no stored-environment coupling.
- `<base>` is an operator-controlled value with fail-fast config validation; the serve-time
  path is pure and unit-testable (S04 tables: present head, absent head, existing base,
  escaped value).
- Re-render (S18) never touches the base — content rows store relative references only;
  `rev`-busted R2 URLs (ADR 0006) stay base-independent.
