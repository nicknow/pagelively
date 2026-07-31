# 0013: S04 implementation details — the `<base>`-injector contract

- Status: accepted
- Date: 2026-07-31

## Context

Slice S04 delivers `src/base-inject.ts` — `injectBase(html, baseHref)`, the pure-logic home of
serve-time `<base>` injection (spec §6, ADR 0008, architecture 02 contract, roadmap S04 AC).
The roadmap ACs pin the behavior (first `<head>` element, create-if-absent, replace existing
bases, never throws, escaped href), but several concrete details were left open and one
**conflict between Phase-2 outputs** needed reconciling before implementation:

- ADR 0008 decision 4 says: html with no `<head>` → **error 500 at render time**, because
  "rendered pages always come from the bundled template".
- The roadmap S04 AC and the planner say: **`<head>` created if absent** (ADR 0008 decision 1
  itself already said "or prepended if absent").

The orchestrator resolved this in favor of **create-if-absent + never throw** (this ADR
records the reconciliation; the roadmap AC wins, ADR 0008 d4 is amended):

- S04's input is not only template output: `html`-kind pages are **user-uploaded** arbitrary
  HTML fragments (§4, §6) with no guarantee of a `<head>`. A 500 there would make valid pages
  unservable, and the AC explicitly lists "unparseable/empty HTML" as a case that must
  "still return a document containing the base (never throws)".
- "Never throws" is also the robustness posture of risk R12 (malformed input must not take
  down serving); it matches the slice philosophy of S01/S02/S03 (total functions, typed
  failures, no raw exceptions from pure modules).
- The "templates always have a head" assumption belongs to `template.ts` (S05) and the
  bundle-pipeline tests, not to this module's contract.

## Decision

### 1. Insertion point — after the FIRST real `<head>` opening tag

The base is injected immediately after the first real `<head>` opening tag's `>` (attributes,
case variants `<HEAD>`/`<Head>`/`<hEaD>`, whitespace `<head >`, and `<head/>` are all
accepted — browsers ignore the self-closing flag on non-void elements, so `<head/>` counts as
a head). When several heads exist, the first wins (consistent with "first base wins" in the
HTML spec's base-element processing, and with a scanner that cannot track tree nesting).

### 2. Created-head placement (no real head found)

The created `<head>` (containing the base) goes after any leading BOM/whitespace, any leading
`<!...>` tokens (comments and doctype, comment-aware), and a leading `<html>` opening tag if
present — browser-like placement: head inside `<html>`, after the doctype. An unclosed
leading comment/declaration/`<html>` is never entered; the head goes before it (or at the
start of the string). Rationale: a doctype must stay first (HTML parser requirement), and a
`<head>` before `<html>` would be dropped by browsers when reparsing — the point of injection
is that the served document is already well-formed.

### 3. "Real" tags — scanner guardrails

A tag is real only if it is a well-formed opening tag found **outside**:

- HTML comments (`<!-- … -->`; an unclosed comment runs to the end and hides everything
  after it),
- attribute values (`>` inside a quoted value does not end the tag),
- the contents of raw-text elements (`script`, `style`, `textarea`, `title`), and
- `<template>` contents — **treated as inert content**: a `<head>` there must not swallow the
  injected base, and a `<base>` there never affects the live document (ADR 0008's
  exactly-one-active-base requirement is about _active_ bases).

Unterminated tags (`<head` with no `>`) are literal text, never a head. The scanner is a
hand-rolled, single-pass, O(n) character scanner (no regex) — no ReDoS surface on adversarial
input, and no case-folding surprises (ASCII-only case-insensitive compares; tag names are
ASCII, and `toLowerCase()` on non-ASCII can change string length and corrupt index
arithmetic).

### 4. Base replacement — every pre-existing base is removed

Every well-formed `<base>` opening tag anywhere in scanned markup is removed before
injection (case-insensitive; tags inside comments/attributes/raw-text/template are untouched,
consistent with decision 3). Exactly one active base remains in the output (S04 AC 4;
ADR 0008 d5). Removal is implemented by splicing the scanned spans out of the string — it
cannot create or destroy other tags, so finding the head on the stripped document is
equivalent to doing both on the original.

### 5. Escaping — full HTML attribute escape

The href is escaped via `escapeHtml` (utils.ts, first consumer): `& < > " '` →
`&amp; &lt; &gt; &quot; &#39;`. This is defense in depth (ADR 0008 d4; risk R12) — the value
is operator/config-controlled, but the injected attribute must not be breakable even if a
future caller passes a hostile string.

### 6. Href normalization — defensive, but not URL validation

The emitted href **always ends with `/`** (S04 AC 2): truncate at the first of `?`/`#`
(whichever comes first — a `#` inside a query still starts the fragment), then append `/` if
the result does not end with one (empty href → `/`). No trimming and **no URL-encoding**: the
caller composes the full href `{ASSET_BASE_URL}/pages/{id}/{rev}/` from an already-validated
base URL, and `ASSET_BASE_URL` validation is `config.ts`'s job (architecture 02), not this
module's. Query/fragment stripping is the one normalization worth doing here so a stray
`?token=` or `#`-suffix can never produce a base that accidentally routes relative assets
through a query.

### 7. Totality — never throws on any input (S04 AC 3 & 6)

Non-string arguments are coerced via `String()`; if coercion itself throws (e.g. `Symbol`),
the value falls back to `""` (the function still returns a valid document containing the
base). Every input — empty string, fragment, adversarial garbage, 50 KB of `<`s — yields a
string containing exactly one base with the normalized href.

### 8. Reconciliation (ADR 0008 d4 vs roadmap) — resolved

**Missing `<head>` → create one, never 500.** ADR 0008 decision 4 is amended by this ADR; the
amendment is kept visible in 0008 (strikethrough + note), not silently rewritten. The
create-if-absent rule was already ADR 0008 decision 1's own "or prepended if absent" wording
and is the roadmap/planner AC; user-uploaded `html`-kind pages are arbitrary fragments, and
the AC's failure case demands a document-with-base, not an error.

## Consequences

- `entry-serve.ts` (S12) gets a single, total function: `injectBase(html, href)` can be called
  with any runtime value and always yields a well-formed result containing exactly one active
  base. No 500 path, no `try/catch` obligation at the call site.
- The module is fully unit-testable on strings (no DOM parser, no bindings) and is covered by
  table tests: head variants, created head, base replacement, escaping, non-string args,
  adversarial inputs, idempotence. `src/base-inject.ts` and `src/utils.ts` at 100% coverage
  (statements/branches/functions/lines) in the suite.
- The scanner's guardrails are a deliberately conservative approximation of HTML parsing:
  first-head-wins and template-as-inert are the documented behaviors tests pin; a full parser
  is out of scope (ADR 0002 dependency policy — no parser library).
- Coverage: suite total ~~221~~ ~~239~~ **257** tests (151 before S04; ~~70~~ ~~88~~ **106**
  added: ~~64~~ ~~82~~ **100** `base-inject` + 6 `utils`); coverage 100% on `src/**`,
  thresholds 85/85/80/85. The review-round fix (exact-name matching in `scanTags` — `<head1>`
  is not `<head>`, `<base-1>` is not `<base>`) added 18 pinning tests on top of the
  validator-probe additions.

## Amendment 2026-07-31 (S04 validation)

Recorded by the S04 validator after independent edge/regression probing. No contract shape
change — `injectBase(html, baseHref)` signature, purity, and totality are untouched; these
refinements make the scanner match the HTML5 tokenizer's guardrail rules the decision text
already claimed:

- **d2 (created-head placement) — doctype internal subsets.** A doctype carrying an internal
  subset (`<!DOCTYPE html [ <!ENTITY x "y"> ]>`) is one token ending at the first `]`
  followed by optional whitespace and `>` (per HTML5, subset content is raw data — quotes and
  `>` inside it do not end the token, and a `]` followed by junk is a parse error that
  continues the subset). A created head is never placed inside the subset (that would be an
  inert head → inactive base). PUBLIC/SYSTEM-identifier doctypes (quoted, no subset) behave
  as before.
- **d3 (raw-text guardrails) — full RAWTEXT enumeration + `plaintext`.** The declared set now
  covers every HTML5 RAWTEXT element: `script`, `style`, `textarea`, `title`, `iframe`,
  `noembed`, `noframes`, `noscript`, `xmp` (the original text enumerated only the first four;
  a `<head>` inside `<iframe>` fallback content was being treated as real and swallowing the
  base into inactive text). `<plaintext>` is special-cased: it makes the rest of the document
  literal text with no closing tag (even `</plaintext>` is literal).
- **d3 (O(n) / no-ReDoS) — unterminated-token semantics corrected.** The original scanner
  resumed scanning one character past an unterminated tag/declaration (`<head` with no `>`),
  re-scanning the suffix for every subsequent `<`: `"a<a".repeat(n)` was O(n²) — ~12 s on
  100 KB (measured), well over the Workers Free 10 ms CPU budget. Per the HTML5 tokenizer,
  an unterminated tag/end tag/declaration consumes the rest of the input (eof-in-tag,
  bogus-comment, eof-in-doctype), so the scanner now advances to the end of input. This
  restores the claimed single-pass O(n) behavior and fixes head-detection inside
  attribute-value tails of unterminated tags. A timing-guard test pins it (100 KB adversarial
  run < 2 s; measured 5 ms post-fix vs 11,991 ms pre-fix; 3 MB of the same input: 48 ms).
- **Known remaining divergences (documented, not fixed):** the scanner is a conservative
  approximation of HTML parsing by design (first-head-wins; template as inert; created-head
  placement handles only LEADING preamble tokens — a `<head>` appearing mid-document with
  text content before it is still treated as real and receives the base, which is a
  content-semantics call for the spec/planner, not the scanner). The `<!-->`-style bogus
  comments (no `-->` present) also follow the scanner's "unclosed comment runs to EOF" rule —
  a created head goes before them, which browsers keep active.

## Review round 2026-07-31 (S04 review)

Recorded by the S04 reviewer + implementer. No contract shape change.

- **d3 (real tags) — exact-name + boundary rule made explicit and enforced.** A tag is real
  only if its name is EXACTLY `head` / `base` (case-insensitive, ASCII) **and** is followed by
  a boundary character: whitespace, `/`, or `>`. The module header always stated "name is
  exactly head", but `scanTags` originally read names as letter-only runs, truncating
  `<head1>` → `head` and `<base-1>` → `base`. Consequences: a base could be injected inside a
  `<head1>` element (inactive in browsers, violating AC 1's "first element inside the first
  real `<head>`"), and a legitimate custom `<base-1>` element was silently deleted (violating
  the exactly-one-**active**-base rule — a `<base-1>` is an ordinary element, not a base).
  Fixed by a shared `hasTagBoundary` check applied to every well-formed opening tag before it
  is recorded; near-miss tags are ordinary elements (skipped whole, contents still scanned).
  Pinned by 18 tests: `<head1>` / `<HEAD1>` / `<head-1>` / `<head.foo>` are never real heads
  (injection lands in a real `<head>` or a created one, and near-miss contents are still
  scanned for a real head); `<base-1>` / `<base-nav>` / `<base.foo>` / `<BASE-NAV>` /
  `<base-1/>` are preserved while an exact `<base>` is removed.

## Cross-references

- Spec: §6 (base href `{ASSET_BASE_URL}/pages/{id}/{rev}/`), §4 (html-kind pages are
  user-uploaded), §14 (serve-time injection), §12 (`ASSET_BASE_URL`).
- Docs: `docs/architecture/02` (contracts — base-inject.ts + utils.ts slots),
  `docs/architecture/05` (error handling), `docs/architecture/08` (coverage thresholds).
- ADRs: 0008 (serve-time `<base>` — **amended here, decision 4**), 0002 (dependency policy),
  0006 (rev/immutability), 0012 (S03 details, suite totals precedent).
- Roadmap: S04 AC; `.work/planner/slices-full.md` S04 section.
