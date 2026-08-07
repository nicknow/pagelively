# 0053: Markdown template system — extractable templates with rich CSS, dark mode, and registry

- Status: accepted
- Date: 2026-08-06

## Context

Work Item T5 delivers a visual upgrade to rendered Markdown pages. Currently
`renderMarkdown()` in `src/markdown.ts` wraps rendered content in a bare-bones inline template
that has no CSS styling — no typography, no colors, no dark mode, no responsive design. Public
Markdown pages look visually flat.

The product spec §7 calls for wrapping rendered Markdown in "a minimal template (readable
typography, responsive)" and notes a future "Re-render all Markdown" action after template
changes, plus theme selection (§17). The existing ADR 0014 records the current minimal template
as a single string constant with a `{{CONTENT}}` slot and no `<base>` tag (which is injected at
serve time by `injectBase()` per OQ-14).

Four architectural questions need resolution:

1. **Where should templates live?** The current template is a constant inside `markdown.ts`,
   coupling rendering logic with presentation markup. Future templates (multiple themes per-page)
   need separation.
2. **How should CSS be delivered?** Workers cannot depend on external CDN resources; the CSS must
   be inline. But inline CSS in a Worker bundle adds bytes to the deployment payload (§15
   Worker script size limit).
3. **How should dark mode work?** Public pages have zero JavaScript (§10 buildless admin; public
   pages are pure HTML). A JS-based dark mode toggle is impossible. The admin UI (ADR 0046) uses
   `@media (prefers-color-scheme: dark)` for CSS-only dark mode with CSS custom properties.
4. **How should template selection work?** The spec (§17) mentions future "theme selection" per
   page. The template system must be forward-compatible with per-page selection without
   requiring a migration today (OQ-25).

## Decision

### 1. Separate template module (`src/templates/`)

A new pure module (`src/templates/`) houses all rendering templates. This is the same module
boundary pattern as the rest of the codebase (02-module-boundaries-contracts.md: pure modules
have no bindings, no side effects, and are fully unit-testable).

**Module structure:**

```
src/templates/
  default.ts   — DEFAULT_TEMPLATE_CSS (string) + renderDefaultTemplate(content): string
  index.ts     — barrel export + template registry
```

- `src/templates/default.ts` exports `DEFAULT_TEMPLATE_CSS` (the design system CSS string) and
  `renderDefaultTemplate(content: string): string` which wraps content in a full HTML document
  with the CSS inlined in `<head>`.
- `src/templates/index.ts` provides a barrel export and a simple registry — a `Map<string,
(content: string) => string>` — mapping template names to render functions.
- Currently only one entry exists: `"default" → renderDefaultTemplate`. The registry is
  extensible by adding entries; no template plugin system or dynamic loading is needed.

**Rationale for separate module:**

- **Separation of concerns:** `markdown.ts` handles rendering (Markdown → HTML); templates
  handle presentation (HTML → full document). A change to typography or colors never requires
  touching the rendering logic.
- **Extensibility:** Adding a new template (e.g., "dark-contrast", "serif") means adding a file;
  no existing code changes except the barrel export.
- **Testability:** Template tests assert CSS strings and document structure independently of
  `marked` behavior.
- **Bundle size:** The CSS is a single string constant (~3–5 KB raw); its contribution to the
  Worker bundle is negligible (~190 KiB raw / 44 KiB gzip currently, well within the 3 MB
  compressed limit — risk R25).

### 2. Inline CSS with CSS custom properties

The template CSS is embedded as a `<style>` element inside `<head>`, directly in the HTML string.
No external CSS files, no `@import`, no `<link>` elements, no CDN references (AC 8).

**Why inline CSS (Workers constraints):**

- The Worker has no file-system access at runtime. CSS must either be inlined in the bundle or
  fetched from R2/storage at serve time (which adds latency and cost).
- R2-served CSS would add a Worker invocation per page load (defeating the "1 + 3" model, spec
  §3: the entry document is the only Worker request). Inlining keeps the page self-contained.
- The bundle size impact (~3–5 KB raw, less under gzip) is negligible against the 3 MB compressed
  limit (§15).

**CSS custom properties pattern:**

- Tokens like `--color-text`, `--color-bg`, `--font-sans`, `--font-mono`, `--max-width` are
  declared on `:root` in the light theme, then overridden in `@media (prefers-color-scheme: dark)`.
- This follows the same pattern as the admin UI's `DESIGN_SYSTEM_CSS` (ADR 0046), which proved
  the approach works: `:root` declares light defaults, `@media (prefers-color-scheme: dark)`
  overrides the same custom properties with dark-appropriate values.
- The admin UI additionally supports explicit `[data-theme="dark"]` and `[data-theme="light"]`
  attribute overrides for its JS toggle (ADR 0048). **Public pages do not include these** — they
  have no JS and no toggle, so only `:root` and the `@media` block are emitted.
- Typography covers: headings (h1–h6), paragraphs, links, inline code, fenced code blocks,
  responsive images, tables (with responsive overflow), blockquotes, lists, and `.source-link`
  (the "View source" link when `showSource` is enabled).

### 3. Dark mode via `@media (prefers-color-scheme: dark)` — CSS-only, no JS

Public Markdown pages are pure HTML documents with no JavaScript (spec §10: "no frontend
framework required for v1"). Dark mode detection must work at the CSS level.

**Decision:** Use `@media (prefers-color-scheme: dark)` exclusively for public pages. The
template contains:

1. `:root { /* light tokens */ }` — the default.
2. `@media (prefers-color-scheme: dark) { :root { /* dark tokens */ } }` — overrides when the
   OS/browser reports dark preference.

**Why not JS-based:**

- Public pages have zero JS; adding JS solely for dark mode adds bytes, increases attack
  surface, and contradicts the "buildless" principle (§14).
- The `prefers-color-scheme` media query has >96% global browser support (caniuse 2026). The
  4% gap (primarily older desktop browsers) get the light theme — a graceful degradation, not
  a broken experience.
- No toggle button means no `data-theme` attribute override blocks. The dark theme follows the
  OS setting automatically — the expected behavior for a reading-focused public page.

**Reduced motion:** A `@media (prefers-reduced-motion: reduce)` block is included (same as
ADR 0046 decision 4), zeroing transitions/animations for users who request it.

### 4. Template selection through `MarkdownRenderOptions`

`MarkdownRenderOptions` gains a `template?: string` field. Default is `"default"`. The
`renderMarkdown` function passes the option through to the template registry.

```ts
interface MarkdownRenderOptions {
  allowRawHtml?: boolean;
  showSource?: boolean;
  template?: string; // NEW — defaults to "default"
}
```

The template registry (`src/templates/index.ts`) is a simple map:

```ts
const registry = new Map<string, (content: string) => string>([["default", renderDefaultTemplate]]);

export function renderTemplate(templateName: string, content: string): string {
  const render = registry.get(templateName);
  if (!render) {
    // Unknown name → fall back to default (OQ-26 recommendation)
    return registry.get("default")!(content);
  }
  return render(content);
}
```

**Fallback policy (OQ-26):** Unknown template names silently fall back to the default template.
This is future-proof: if a template is deprecated or a page references a template that no longer
exists, the page still renders rather than 500-ing. Never fail on a template selection.

**Per-page storage (OQ-25):** Template selection is not stored per-page yet. The field exists
only in `MarkdownRenderOptions` and defaults to `"default"` for all pages. When per-page
selection is added (spec §17 "theme selection"), the template name becomes:

- A `template` column on the `pages` D1 table (nullable, defaults to `"default"`)
- A field on `NewPage` / `MetaPatch` for create and edit APIs
- Subject to the same `show_source`/`visibility` patch contract

This separation means T5 requires **no migration** and **no API change** — the template option
is purely internal to the render path.

### 5. No change to existing contracts

The following behaviors are preserved unchanged:

- **`<base>` injection contract.** The template leaves `<head>` as a clean base slot; no `<base>`
  tag is emitted. `injectBase()` from `src/base-inject.ts` still inserts the `<base>` as the
  first element of `<head>` at serve time (ADR 0008, OQ-14). The `<style>` element comes after
  the base slot — `injectBase` inserts before any content, so the ordering is:
  `<head><base href="..."><style>/* CSS */</style>...` — verified by the composition test.
- **`{{CONTENT}}` slot replacement.** The replacement stays single-pass and `$`-safe, using a
  function callback (`TEMPLATE.replace(CONTENT_SLOT, () => body + sourceLink)`) per the ADR 0014
  amendment. The slot mechanism is identical; only the surrounding template changes.
- **`showSource` behavior.** `showSource: true` appends `<p class="source-link"><a
href="source.md">View source</a></p>` after the rendered body, inside `<main>`. The CSS includes
  `.source-link` styling. No change to the link text or placement.
- **`allowRawHtml` behavior.** The raw-HTML policy (ADR 0002 decision 4) is unchanged. CSS
  is in `<head>` and `marked` never sees it, so no CSS can be affected by the escaping mode.
- **`renderMarkdown` failure contract.** Renderer failure still throws a typed
  `AppError("markdown_render_failed", 500)`. The template wrapping function
  (`renderDefaultTemplate`) is pure and never fails — wrapping a string in HTML is infallible.
- **No bindings.** The template module imports nothing from the runtime (`env`, `ctx`, `cf`).
  Pure function, fully unit-testable with no emulation.

### 6. Bundle size gate

The CSS adds an estimated 3–5 KB raw (less under gzip compression). The S23 build gate measured
~190 KiB raw / 44 KiB gzip. Even at worst case (+5 KB raw, ~+1.5 KB gzip), the bundle stays well
within the 3 MB compressed Worker limit (§15, risk R25). The `npm run build` gate verifies this
on every PR.

## Consequences

- **Visual improvement:** Public Markdown pages render with readable typography, responsive
  layout, and automatic dark mode — the most user-visible change since the bare-minimum template
  was shipped in S05.
- **Extensible architecture:** Adding a new template is a single file + registry entry, with no
  changes to `markdown.ts` or any handler. The spec's "theme selection" (§17) is now one column
  addition away.
- **No breaking changes:** All existing tests for `renderMarkdown`'s rendering behavior (headings,
  tables, raw-HTML escaping, `$` safety, deep nesting) continue to pass; only the test-side
  `HEAD`/`TAIL`/`wrap()` helpers are updated to match the new template structure. The
  composition test (`renderMarkdown + injectBase`) verifies the base-slot contract is preserved.
- **Bundle growth:** ~3–5 KB raw added. This is acceptable (risk R25 mitigated). The `npm run
build` gate prevents unnoticed growth.
- **CSS-assertion tests:** New tests parse the CSS string for specific rules (`@media
(prefers-color-scheme: dark)`, custom property declarations, typography selectors). These are
  string-inclusion tests on the exported `DEFAULT_TEMPLATE_CSS` constant.
- **Simpler future re-render:** The "Re-render all Markdown" action (§7, §17) will apply the
  current template selection to all Markdown pages, using the same `renderDefaultTemplate`
  function — no template-retrieval logic needed beyond the registry lookup.

## Cross-references

- Spec: §7 (Markdown handling), §14 (toolchain), §15 (limits), §17 (future enhancements — theme
  selection, re-render all).
- ADRs: 0002 (language/runtime/dependency policy), 0008 (base injection), 0014 (S05 Markdown
  rendering pipeline — the current template), 0046 (CSS design tokens, dark palette for admin UI).
- Docs: `docs/architecture/02-module-boundaries-contracts.md` (pure module pattern),
  `docs/architecture/03-data-model.md` (D1 schema — `template` column not yet present).
- Code: `src/markdown.ts` (renderMarkdown), `src/admin-ui.ts` (DESIGN_SYSTEM_CSS pattern),
  `test/markdown.test.ts` (existing tests — HEAD/TAIL/wrap helpers updated).
- Risks: R25 (bundle size), R26 (CSS stripping), R27 (browser compatibility).
- Open questions: OQ-25 (per-page template storage — deferred), OQ-26 (unknown template name
  — fallback resolved).
