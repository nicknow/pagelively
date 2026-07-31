# architect scratch

Working notes for the `@architect` agent. Git-ignored and disposable; promote anything durable to `docs/` or `.ai/` (see `.ai/workflows/knowledge-promotion.md`).

## Phase 2 status (2026-07-31)

- **Spike (week one) — done.** See `spike-cache-emulation.md` in this directory. Outcome:
  Workers Caching **purge is not emulated** by the Vitest Workers pool (Miniflare exposes only
  the Cache API plugin, `cache?: boolean`; `cloudflare:workers` `cache` is an empty object in
  the pool). Cache seam → contract-level tests + operator checklist. Formalized as
  ADR `docs/adr/0009-cache-emulation-seam.md`.
- **Deliverables — done.** `docs/architecture/` (01–08), ADRs 0002–0009, roadmap OQ
  resolutions and coverage threshold, `vitest.config.mts` threshold update. Gates run; report
  delivered to the orchestrator.
- **Left for the human (user-visible/scope OQs):** OQ-06 (PDF upload), OQ-07 (R2 404),
  OQ-08 (home serve vs redirect), OQ-09 (PUBLIC_LISTING), OQ-10 (rev GC), OQ-13 (re-render
  all). Architect decisions stand as recommendations; do not silently close.
