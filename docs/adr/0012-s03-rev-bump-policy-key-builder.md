# 0012: S03 implementation details — rev bump policy and the R2 key builder

- Status: accepted
- Date: 2026-07-31

## Context

Slice S03 ("Rev handling") delivers `src/rev.ts` — `nextRev`, `shouldBumpRev`, and
`buildR2Key` — the pure-logic home of the `rev` cache-busting scheme (spec §8, ADR 0006,
architecture 02 contract, architecture 04 purge matrix). Several concrete details were left
open by the ACs and needed a decision: the exact `RevAction` union surface, the error
taxonomy for the module's fail-fast throws, the precise normalization/escape rules of the
key builder, and — critically — a **conflict between Phase-2 outputs that the orchestrator
asked this slice to reconcile**.

The conflict: ADR 0006 decision 5 says "slug PATCH bumps"; architecture 04's purge matrix,
the roadmap S03 AC, and OQ-04 say metadata edits (including slug) do **not** bump. The
orchestrator resolved this in favor of **no bump on slug-edit**:

- Metadata edits are invalidated by the `page-{id}` tag purge at **zero storage cost**
  (architecture 04): bumping them would copy the whole rev folder per typo (OQ-04 option A
  rationale; R2 free tier is 10 GB — bounded, but churn is waste).
- Per ADR 0008, the `<base>` tag is injected **serve-time** and template links are
  **relative** — so a slug change produces **identical entry HTML bytes** for a given rev.
  Nothing in the served content depends on the slug; only the URL path changes, and the
  tag purge refreshes both the old- and new-slug URLs (one tag, both URLs).
- ADR 0006's own stated principle is "only content-affecting mutations bump" — slug is
  metadata, not content. The "slug PATCH bumps" sentence was the inconsistent clause.

## Decision

### 1. `RevAction` — a closed 7-member discriminated union

```ts
type RevAction =
  | { type: "file-add" } // add or replace a file
  | { type: "file-delete" }
  | { type: "entry-change" } // entry document content changed
  | { type: "re-render" } // markdown re-render (template changes, OQ-13)
  | { type: "slug-edit" } // PATCH slug — does NOT bump
  | { type: "meta-edit" } // PATCH title/visibility/show_source — does NOT bump
  | { type: "create" }; // new page — rev starts at 1 (§8 DEFAULT 1)
```

- Members carry a bare `{type}` tag today; payloads (e.g. a file path) can be added later
  without breaking the switch. The union is **closed by design** — anything else must throw
  (decision 3).
- **Page deletion is not a member.** A deleted page has no rev to bump; S18's delete
  handler purges the tag and removes objects without consulting `shouldBumpRev`. This keeps
  the union exactly at the AC's enumerated surface.

### 2. `shouldBumpRev` — the bump table (architecture 04 matrix)

| Action       | Bump? | Why                                                                                                                                                  |
| ------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| file-add     | true  | file bytes change → new immutable URL set                                                                                                            |
| file-delete  | true  | content-affecting (matrix row: "Yes (content-affecting)")                                                                                            |
| entry-change | true  | entry bytes change → new `{rev}` folder + re-pointed rows                                                                                            |
| re-render    | true  | rendered entry HTML changes (OQ-13 future action)                                                                                                    |
| slug-edit    | false | metadata only; tag purge refreshes both URL forms; entry HTML unchanged (serve-time `<base>`, ADR 0008)                                              |
| meta-edit    | false | title/visibility/show_source are metadata; purge covers them (OQ-14: show_source toggle changes only the rendered entry HTML, which purge refreshes) |
| create       | false | rev starts at 1 (§8 `DEFAULT 1`) — nothing to bump                                                                                                   |

### 3. Fail-fast errors (typed `AppError`, never raw)

- **Unknown/missing/non-string action type → `AppError("unknown_action", 500)`** — never
  silently no-bump (planner AC failure case). A runtime shape guard first rejects
  non-object values so JS-interop garbage yields the typed error, not a raw `TypeError`.
- **`nextRev` and `buildR2Key` guard rev with one shared check** —
  `Number.isInteger(rev) && rev >= 1` → else `AppError("invalid_rev", 500)`. This rejects
  0, negatives, floats, `NaN`, `±Infinity`, and non-numbers (rev invariants are
  correctness-critical; ADR 0006). Status 500 because an invalid rev is an internal
  invariant violation (corrupt row / caller bug), never client input — the S12 boundary
  maps it to the generic 500.
- **`buildR2Key` escape/absolute/empty → `AppError("path_traversal", 400)`** — the
  architecture-05 taxonomy already lists `path_traversal` under 400; S17 maps it to a 400
  upload rejection. Distinct `publicMessage` per rejection class (escape / absolute /
  empty-after-normalize).
- `invalid_rev` and `unknown_action` are new 500-row codes; they surface as the generic
  `internal` 500 at the boundary (never client-visible as their own codes) — recorded in
  architecture 05 for the taxonomy's completeness.

### 4. `buildR2Key` — normalization and escape rules

Contract: `buildR2Key(pageId, rev, path)` → `pages/{id}/{rev}/{path}` (spec §8; hard
layout, never invent a parallel one). The path is processed as **segments**:

1. Reject absolute paths (leading `/`) immediately.
2. Split on `/`; walk segments with a stack: empty segments and `.` are dropped
   (collapses `//` and `./`); `..` pops the stack — **rejected only when it would pop
   below the root** (escape); otherwise the segment is pushed (after popping for `..`).
3. Reject if the normalized result is empty (covers `""`, `"./"`, `"."`, `"a/.."`).
4. Join with `/` under `pages/{id}/{rev}/`.

Consequences the tests pin:

- `images//pic.png` → `images/pic.png`; `./style.css` → `style.css`;
  `a/../b` → `b` (non-escaping `..` collapses by popping — AC-literal: only **escapes**
  are rejected; S17's upload validation rejects `../` anywhere, which is the stricter
  front line).
- Trailing slashes are stripped as a normalization artifact (`images/` → `images`) —
  consistent with duplicate-slash handling; a path that normalizes to empty is rejected.
- **Keys are built from already-decoded strings**: `%2e%2e` and any `%`-sequence are
  **literal characters**, never decoded or reinterpreted by the builder. This is safe:
  an object stored under a literal `%2e%2e` key is unreachable by traversal at the CDN —
  the decoded request path (`/pages/{id}/{rev}/../…`) resolves to a key that was never
  written, so it 404s. The write-side `../` rejection at the upload layer (S17) remains
  the front line. (Open note for S17: reject `%` in multipart filenames to avoid
  storing unservable keys.)
- Backslashes are literal characters (R2 keys are `/`-separated only).
- `..`-lookalike segments (`a..b`, `...`, `.hidden`) are literal — exact-segment matching.
- The page id is **not** re-validated here: `validateId` owns that at the API boundary
  (ADR 0010), and its charset contains no `.` or `/`, so an id cannot traverse.

### 5. Reconciliation (ADR 0006 vs architecture 04) — resolved

**Slug PATCH does NOT bump the rev.** ADR 0006 decision 5 is amended by this ADR; the
amendment is kept visible in 0006 (strikethrough + note), not silently rewritten. The
reconciled position — architecture 04 matrix + roadmap S03 AC + ADR 0006's own "only
content-affecting mutations" principle — is the one this slice implements and tests.

## Consequences

- S17/S18 get a single, total, throw-on-unknown policy function: content mutations bump,
  metadata edits don't, and a future action type added to the union without a case here
  fails loudly (runtime throw + the unknown-action tests) instead of silently corrupting
  the rev sequence.
- `buildR2Key` is the one place keys are made (architecture 02), and it cannot produce a
  key outside the page namespace: traversal, absolute paths, and empty paths are typed
  400s; normalization is deterministic and test-pinned.
- Rev immutability (ADR 0006 d5: "no page with `rev > 0` is mutated in place") holds
  because the bump decision is binary and content-only; metadata edits rewrite rows and
  purge, never copying the rev folder.
- Coverage: `src/rev.ts` fully branch-covered by the S03 table tests (suite total 151;
  coverage 100% on `src/**`, thresholds 85/85/80/85).

## Cross-references

- Spec: §8 (R2 layout `pages/{id}/{rev}/…`, `rev` DEFAULT 1), §5 (admin PATCH surface).
- Docs: `docs/architecture/02` (contracts — rev.ts slot),
  `docs/architecture/04` (purge matrix + rev model), `docs/architecture/05` (error
  taxonomy), `docs/architecture/03` (rev semantics).
- ADRs: 0006 (caching/rev decision — **amended here, decision 5**), 0008 (serve-time
  `<base>`), 0010 (S01 id details), 0005 (errors).
- Roadmap: S03 AC; `.work/planner/slices-full.md` S03 section.
