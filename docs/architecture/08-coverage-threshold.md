# 08 — Coverage threshold

The agreed project coverage bar, replacing the 80% placeholder in `vitest.config.mts`
(ADR 0003 records the decision; this page holds the rationale).

## The number

| Metric     | Threshold |
| ---------- | --------- |
| Lines      | **85%**   |
| Statements | **85%**   |
| Functions  | **85%**   |
| Branches   | **80%**   |

Scope: `src/**` (Worker code). `setup.mjs` is excluded from the coverage run by
`include: ["src/**"]` — it is covered by mock-based tests (S20) by necessity, not by the
coverage bar (06).

## Why this number

1. **The suite is test-first by contract** (`.ai/standards/test-standards.md` #1): every slice
   ships failing tests before code, happy path + edge cases + failure modes. The plan
   front-loads the pure-logic slices (S01–S09) that are exhaustively table-tested — the
   _composition_ of the codebase is logic-heavy, so lines/statements/functions at 85% is a
   real but achievable bar, not a rubber stamp.
2. **Branches at 80%, not 85%**: the honest ceiling is lower for string-templated surfaces —
   admin UI HTML (S19), defensive guards (malformed-HTML fallbacks in S04, error-boundary
   branches in 05), and `no-store`/error paths that are hard to reach _and_ cheap to leave
   partially covered. 80% keeps the branch gate meaningful without forcing contorted tests
   for template strings.
3. **Verified against the current suite**: at Phase 2 the stub + smoke tests report 100%
   (4 statements/2 branches/1 function), so the raised threshold does not break the existing
   gate; as slices land, each slice's own tests carry the ratio (06 slice→module map).
4. **Placeholder was 80% everywhere** (roadmap §8 handoff note); the lift reflects the
   "logic-heavy, infra-light units get the most coverage" guidance in the brief's testing
   requirements.

## Enforcement

- `npm run test:coverage` is a per-slice gate (DoD; 06); the validator independently confirms
  coverage and the full-suite green state.
- Coverage is over `src/**` with the istanbul provider (the pool rejects the v8 provider —
  ADR 0001).
- If a later slice legitimately cannot meet a metric (e.g. an untestable branch), the
  implementer surfaces it in the slice report with a proposed threshold change and the
  human/architect adjusts **the document and this page together** — never a silent config
  tweak.

## Cross-references

- Docs: [06 — Test strategy](06-test-strategy.md) (gates, seam strategy).
- ADR: 0003 (test framework and binding emulation — records the threshold).
- Standards: `.ai/standards/test-standards.md` (coverage targets, rules 1–2).
