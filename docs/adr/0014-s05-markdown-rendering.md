# 0014: S05 implementation details — the markdown rendering pipeline

- Status: accepted
- Date: 2026-07-31

## Context

Slice S05 delivers `src/markdown.ts` — `renderMarkdown(md, opts)`, the pure-logic home of the
markdown rendering pipeline (spec §7, §14; ADR 0002 decision 4; architecture 02 contract;
roadmap S05 AC). The roadmap ACs pin the behavior (marked, Workers-compatible; minimal
responsive template with a `<head>` base slot; raw HTML iff `ALLOW_RAW_HTML_IN_MD`; optional
relative `source.md` link; renderer failure → typed error), but three concrete details were
left open and needed resolution before implementation:

1. **marked v18 renderer wiring.** Marked changed its renderer-extension API: a per-call
   _partial_ renderer option (`marked.parse(md, { renderer: { html } })`) throws
   `this.renderer.heading is not a function` (verified against marked@18.0.7), while
   `marked.use({ renderer: { … } })` mutates the **global singleton**. The docs
   (https://marked.js.org/using_pro) present `use()` extensions as the way to override
   renderer methods.
2. **Raw-HTML escaping semantics.** ADR 0002 decision 4 says: no sanitizer; when
   `ALLOW_RAW_HTML_IN_MD=false`, raw HTML is "escaped". _What exactly_ gets escaped, and with
   which escaping function, was unspecified — and getting it wrong double-escapes user text or
   leaks executable markup.
3. **Template + link shape.** The template's exact structure (needed for the S04 injector to
   target a real `<head>`) and the show-source link's form/placement were unspecified beyond
   "relative `source.md` per OQ-14".

## Decision

### 1. Two isolated `Marked` instances, built once at module load

`src/markdown.ts` constructs `const passthroughMarked = new Marked()` and
`const escapingMarked = new Marked()` and registers the escaping `html` renderer on the second
via `escapingMarked.use({ renderer: { html } })`. `renderMarkdown` picks the instance from the
`allowRawHtml` option; the global `marked` singleton is never touched. This sidesteps both v18
constraints (no per-call partial renderer; no singleton mutation) with no per-call allocation,
and is re-entrancy-safe: `renderMarkdown` is fully synchronous, so no work can interleave
between `use()`-time and parse-time (module load only). `parse(md, { async: false })` is used
so TypeScript resolves the sync `string` overload.

### 2. Escaping = `escapeHtml(token.text)` on every raw-HTML token; entities re-escaped by design

The custom renderer handles **both** raw-HTML token kinds — block `Tokens.HTML` and inline
`Tokens.Tag` (verified: both route through the single `html()` method) — and returns
`escapeHtml(token.text)` (the shared helper from `src/utils.ts`, `&` first). Consequences:

- `<script>alert(1)</script>` → `&lt;script&gt;alert(1)&lt;/script&gt;` — inert text, never
  executed (risk R12).
- Entities inside the raw markup are escaped a second time (`&amp;` → `&amp;amp;`). This is
  deliberate: the output is _text that displays the literal source markup_; a browser must not
  re-decode `&amp;` back to `&` and render the markup. The marked docs show the same pattern
  (`html(token) { return escapeHtmlEntities(token.text); }`, "strip or sanitize raw HTML").
- No sanitizer, no allow-list, no DOM parsing — ADR 0002 decision 4 (single-operator trust).

### 3. Template: one constant with a content slot; head = base slot + charset + viewport

`TEMPLATE` is a single string constant in `src/markdown.ts` containing a `{{CONTENT}}` slot,
rendered via `TEMPLATE.replace(CONTENT_SLOT, body + sourceLink)`. Structure:

- `<!doctype html>` + `<html lang="en">`;
- `<head>` containing `<meta charset="utf-8">` and the responsive viewport meta
  (`width=device-width, initial-scale=1`) — and **no `<base>`**: the head is a base _slot_ the
  S04 serve-time injector targets (OQ-14: template links stay relative; base applied at serve
  time, never by `renderMarkdown`);
- `<body><main class="markdown-body">` — the readable typography container;
- no external CSS or JS.

The show-source link (AC 3) is a constant appended directly after the rendered body inside
`<main>`: `<p class="source-link"><a href="source.md">View source</a></p>`. The href is
relative `source.md` per OQ-14 (resolved against the serve-time base); placement and link text
are editorial and pinned by tests.

### 4. Option surface: exactly two booleans; kind-gating is caller-side

`MarkdownRenderOptions = { allowRawHtml?: boolean; showSource?: boolean }`. The planner's
"showSource on non-markdown → ignored" guard is **structural**: `renderMarkdown` only ever
receives markdown, so no kind option exists to misuse — extra keys are dropped by
destructuring, and kind gating of the eventual `show_source` passthrough belongs to the S17
entry-serve boundary. `ALLOW_RAW_HTML_IN_MD` env parsing stays in config.ts (later slice).

### 5. Failure contract: typed AppError, never a partial page

`marked.parse` is wrapped in try/catch; any throw (malformed/adversarial input such as
10k-deep nested blockquotes → `RangeError: Maximum call stack size exceeded`, or non-string
input) surfaces as `AppError("markdown_render_failed", 500, "Markdown content could not be
rendered.", { cause: <original message> })`. S17 surfaces this as a failed publish — a
half-written page is impossible by construction.

## Consequences

- **Enables:** S17's publish pipeline can consume `renderMarkdown` and apply `injectBase`
  at serve time (OQ-14); the escape path is fully unit-tested without any marked mocking.
- **Forecloses:** sanitizing/allow-listing raw HTML (deliberately — ADR 0002 decision 4); a
  per-call renderer API (v18 doesn't support it — this is now documented here and in the
  module docstring, so no future slice reintroduces the throwing pattern).
- **Bundle:** `marked@^18.0.7` added to `dependencies` (zero-dep; ESM ~42 KB raw / ~13 KB
  gzip). The S05 build gate is green: `npm run build` prints 0.70 KiB total because the
  Phase-0 stub entry does not import `markdown.ts` yet — marked's real bundle weight lands
  with S17 entry-serve, still far inside the 3 MB compressed free limit (§15; risk R5).
- **Coverage:** the `err instanceof Error ? err.message : String(err)` else-path is defensive
  dead code in practice (marked always throws `Error` instances); it is left in place rather
  than mocked away.

## Amendment 2026-07-31 (S05 validation)

Recorded by the S05 validator after independent edge/regression probing. No contract
shape change — signature, purity, and totality are untouched.

- **Decision 3 (slot replacement) — must use a FUNCTION replacement, not a string
  replacement value.** `TEMPLATE.replace(CONTENT_SLOT, body + sourceLink)` scans a _string_
  replacement value for `$` substitution patterns (`$&`, `$'`, "$\`", `$$`). User content
  containing them corrupted the document: `$$` collapsed to `$`(silent data loss, plain
text, both modes);`$'` rendered as `$&#39;`whose`$&` expanded back into `{{CONTENT}}`
  (slot re-injected into user content); raw HTML such as `<div>$'</div>` (allow mode)
spliced the template tail (`</main></body></html>`) into the body. Fixed to
`TEMPLATE.replace(CONTENT_SLOT, () => body + sourceLink)`— a function is invoked once with
the matched slot text and its return value is inserted verbatim, so no`$`pattern is
ever processed. The literal user text`{{CONTENT}}` was and remains safe (single-pass:
  the body is the replacement _value_ and is never re-searched). Pinned by 6 regression
  tests incl. a structural-integrity sweep over both modes.
- **Deep-nesting boundary.** 10k blockquote levels throw (`RangeError` → typed AppError);
  2k levels render fine (pinned). The `instanceof Error` else-path on the cause remains
  deliberately untested (marked always throws `Error` instances; mocking a zero-dep
  deterministic library is against test-standards — dead code kept, documented).
