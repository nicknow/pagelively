# Architecture (`docs/architecture/`)

How the pieces fit together: module boundaries and contracts, the data model (D1 schema, `rev`),
the caching model, error handling, and the concrete test strategy — with every significant
decision recorded as an ADR in `docs/adr/`.

The authoritative description of _what_ we build remains `docs/product-spec.md` (spec §refs
are cited throughout); these documents describe _how_ the pieces fit, as implemented. They're
kept up to date as the code changes — the doc that owns a given surface is updated in the same
commit as any change to that surface.

## Documents

| Doc                                                                     | Covers                                                                                                      | Key ADRs                                           |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [01 — System overview](01-system-overview.md)                           | Components, request flows, deployment topology, the "1 + 3" model as built                                  | 0006 (caching), 0008 (base), 0041 (S23 protected surface) |
| [02 — Module boundaries & contracts](02-module-boundaries-contracts.md) | Directory layout, TypeScript-facing interfaces, the test seams (cache, JWKS, setup.mjs)                     | 0002 (toolchain), 0005 (errors), 0009 (cache seam), 0041 (S23 contracts) |
| [03 — Data model](03-data-model.md)                                     | D1 schema + `rev` semantics, R2 key layout, KV JWKS cache, invariants, migration policy                     | 0006 (rev), 0007 (slugs), 0041 (password_hash, page_unlocks) |
| [04 — Caching & `rev` model](04-caching-rev-model.md)                   | Route-class headers, the purge matrix, rev-bump policy, entrypoint constraint, cold-cache-per-deploy        | 0006, 0009, 0041 (protected class, no-store) |
| [05 — Error handling](05-error-handling.md)                             | Error taxonomy, status codes, error boundary, the 413 guard, fail-closed auth                               | 0005                                               |
| [06 — Test strategy](06-test-strategy.md)                               | Local emulation, mock-JWKS matrix, layer coverage, slice → module mapping, infra seams → operator checklist | 0003, 0009                                         |
| [07 — Toolchain](07-toolchain.md)                                       | Language, dependencies (`marked`, `jose`), ids, router decision, devcontainer, types                        | 0002, 0003, 0004                                   |
| [08 — Coverage threshold](08-coverage-threshold.md)                     | The agreed project coverage bar and why                                                                     | 0003                                               |

## Decisions not in an ADR (recorded here / in the roadmap)

Minor architect-owned resolutions (roadmap §5 OQ table): OQ-05 (bundle `.md` entries render
through the §7 pipeline), OQ-11 (ambiguous entry → 400, UI forces a picker), OQ-12
(`ACCESS_TEAM_DOMAIN` stored bare, `https://` prepended defensively). Human-owned OQs
(OQ-06, OQ-07, OQ-08, OQ-09, OQ-10, OQ-13) remain open with recommendations — see the roadmap.
