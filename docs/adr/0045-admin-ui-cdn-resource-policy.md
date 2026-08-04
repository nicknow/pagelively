# 0045: Admin UI CDN resource policy — pinned, judicious external resources permitted

- Status: accepted
- Date: 2026-08-04

## Context

ADR 0028 and ADR 0039 established a hard "no CDN, no framework, buildless" rule for the admin
UI, motivated by the Workers Free-tier bundle-size ceiling (ADR 0031: 3 MB gzip limit, ~35 KiB
used) and by keeping the Worker fully self-contained.

A visual modernization pass wants the option to use small, well-chosen external resources (e.g.
a webfont) where inlining genuinely can't match the result. Blanket-banning this forecloses
reasonable options; blanket-allowing it reopens supply-chain and reliability risk this project
has otherwise avoided everywhere else (single-operator trust model, ADR 0002/0005).

## Decision

`/admin*` routes (`src/admin-ui.ts` only) may reference external resources under **all** of the
following conditions:

1. **Reliable, immutable-by-version CDN only** — e.g. `cdn.jsdelivr.net/npm/<pkg>@<exact-semver>/...`
   or an equivalently pinned path. Never a "latest", branch, or otherwise mutable alias.
2. **Exact version pin**, not a semver range — the URL's content must never change silently
   after this ADR is written.
3. **Subresource Integrity required wherever the CDN supports it** — `integrity="sha384-..."` +
   `crossorigin="anonymous"` on the tag, so a compromised or altered origin fails closed (the
   browser refuses the resource) instead of silently serving something different than what was
   reviewed.
4. **Graceful degradation is mandatory** — if the resource fails to load (network policy,
   ad-blocker, offline, CDN outage), the admin UI must remain fully usable and legible with no
   layout break. A webfont, for example, needs `font-display: swap` and the existing
   `system-ui` stack as the CSS fallback list, not a hard dependency.
5. **Scope: `/admin*` only.** This does _not_ apply to `src/password-prompt.ts` (ADR 0041 —
   must stay fully inline, no external references, to preserve the protected-page privacy
   posture) or the public `src/markdown.ts` template (must stay dependency-free so arbitrary
   published pages never inherit an admin-only network dependency).
6. **Judicious, not default.** The bar is "this materially improves production quality in a way
   inline CSS/SVG cannot" — not "now that it's allowed." Any concrete resource added must be
   named and justified in this ADR (or a follow-up ADR) at the time it's added, including the
   exact pinned URL, integrity hash, and fallback behavior verified.

### Resolution for this pass (2026-08-04 modernization)

No CDN resource is added. The system font stack (`system-ui, -apple-system, ...`) already reads
as professional on every major OS, and the visual upgrade is achieved entirely through inline
CSS (design tokens, dark mode, motion) and a hand-authored inline SVG icon sprite — zero new
network dependency. This is the "judicious" default this ADR asks for: the allowance exists for
a future case where it's clearly warranted (e.g. a data-viz library if the admin UI grows
charts), not exercised reflexively here.

## Consequences

- The bundle-size gate (ADR 0031) still bounds what's _inlined_, but no longer bounds the full
  admin experience if a CDN resource is ever added — that resource's own size/latency becomes a
  live, non-gated cost. A future addition should note expected resource size and load impact.
- The operator checklist (`docs/operations/smoke-test-checklist.md`) should gain a line item, if
  and when a CDN resource is actually added, to verify it's still reachable/current at deploy
  time and that the degraded (resource-blocked) rendering was checked.
- `src/password-prompt.ts` and `src/markdown.ts` remain exactly as strict as before — this ADR
  narrows only the `/admin*` surface.

## Cross-references

- Amends: ADR 0028 (S19 admin UI), ADR 0039 (T3 admin UI modernization).
- Does not affect: ADR 0041 (password-protected pages / prompt page), ADR 0031 (build-size gate).
- Spec: §10 (admin UI), §14 (tech choices — "no frontend framework required" still holds; this
  ADR is about optional static resources, not a framework), §15 (bundle-size constraints).
