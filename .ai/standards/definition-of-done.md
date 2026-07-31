# Definition of Done

The checklists every slice and every phase must satisfy before it is reported as done.

## Per slice

- [ ] Acceptance criteria (from `docs/development/roadmap.md`) are met.
- [ ] Tests were written **first** (failing), then the minimum code to pass.
- [ ] Full test suite is green — no failing or skipped tests.
- [ ] `npm run typecheck` clean.
- [ ] `npm run lint` and `npm run format:check` clean.
- [ ] Coverage meets the agreed threshold (`npm run test:coverage`).
- [ ] Human docs (`docs/`) and agent docs (`.ai/`) updated for the slice.
- [ ] ADR written in `docs/adr/` if a decision was made.
- [ ] Durable knowledge promoted out of `.work/`; slice scratch cleaned.
- [ ] Conventional commit on a feature branch.
- [ ] No forbidden action taken (no deploy, no live Cloudflare access, no secrets, no scope creep).

## Per phase / overall

- [ ] All slices done and reviewed.
- [ ] End-to-end behaviors match the spec via the local dev loop.
- [ ] README quickstart works from a clean devcontainer.
- [ ] Operator smoke-test checklist exists in `docs/operations/`.
- [ ] Open-questions log is empty or explicitly deferred with rationale.
