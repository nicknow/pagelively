# 0007: Slugs and reserved words

- Status: accepted
- Date: 2026-07-31

## Context

The spec (§4) prescribes slug generation/validation from page titles, §5 lists reserved words
(`p, api, admin, assets, favicon.ico, robots.txt, health`), and §13 requires id-only routes to
bypass slugs. The roadmap (§8) asks for an ADR on the `slugify` function, the reserved-word
list, and their interplay with the route classifier. Two gaps to close: "similar words"
(§5.2) is not formally defined, and a decision is needed on whether reserved words are
blocked only when matched exactly at the top level or anywhere.

## Decision

1. **Slug generation** (`slugify`, S01): lowercase; ASCII-alphanumeric plus `-` and `_`;
   Unicode letters outside ASCII map to `-` (or drop if the segment is empty) — no diacritic
   transliteration, keeping URLs stable and non-dependency (`deburr` would be another lib;
   ADR 0002 policy). Runs of non-alphanumeric chars collapse to a single `-`; leading/trailing
   `-` trimmed; empty result → error (400 at the API). "Similar words" (§5.2) = the same
   function applied to both strings; collision → 409.
2. **Reserved words** (S02): exact-match on the **whole first path segment**:
   `p, api, admin, assets, favicon.ico, robots.txt, health, sitemap.xml` (roadmap table +
   `sitemap.xml`). Case-insensitive compare (routes are case-normalized by the classifier
   anyway). Blocked for any purpose — slug or id — so `/p/...` (id routes, §13) can never be
   shadowed by a page named `p`. Reserved-_prefix_ rules exist too: any segment starting with
   `_` is reserved (future-internal, §5.1); no other prefix rules (e.g. `_pages` is reserved,
   `pages` is not).
3. **Interplay with routing** (S01/S02): `classifyPath` runs before any DB access — reserved
   and non-canonical paths are decided by pure functions; slug lookups never query for a
   reserved word (guaranteed by construction, not by post-hoc checks).
4. **Id-only routes** (`/p/{id}/`, `/api/pages/{id}/...`) are slug-agnostic by design (§13);
   slug uniqueness (`slug` unique index, 0001 schema) is the only correctness invariant
   enforced by the store.

## Consequences

- The URL surface is small, deterministic, and fully unit-testable (S01/S02 tables), including
  the "similar words" 409 case.
- `/p/`, `/admin/`, `/api/`, `/assets/` remain structurally unmountable; the classifier and
  the reserved list are the same source of truth (single `reserved.ts` module, no duplicated
  constants).
- No transliteration means non-Latin titles degrade to `-`-collapsed slugs; the admin UI
  shows the generated slug on create (S17) so the operator can override — matching spec §4's
  "manual override" escape hatch.
