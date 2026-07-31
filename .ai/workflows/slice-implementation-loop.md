# Workflow: the per-slice implementation loop

How a slice gets built, from acceptance criteria to a closed, committed, reviewed slice. This
is the loop the orchestrator runs with the subagent team; implementer, validator, and reviewer
each have their own step.

## The loop

1. **Restate** the slice's acceptance criteria from `docs/development/roadmap.md` (happy path,
   edge cases, failure modes).
2. **Write failing tests** covering those criteria.
3. **Implement** the minimum code to pass.
4. **Run gates:** full suite, typecheck, lint/format, coverage threshold — all green.
5. **Validate** (`@validator`): independent check against the _spec_, extra edge/regression
   tests, checklist additions for infra seams.
6. **Review** (`@reviewer`): quality, standards, docs updated, knowledge promoted, scratch
   clean, boundaries respected → verdict.
7. **Commit** on a feature branch (Conventional Commit); clean the slice's `.work/` scratch.
8. **Report** the slice outcome to the human; pause at the agreed cadence.

## Rules

- Do not start the next slice until the current one closes (all steps green, verdict
  approve).
- Never mark a slice done with a failing or skipped test, or reduced coverage.
- Each role works only in its own `.work/<name>/`; no role depends on another's scratch.
- Anything durable discovered during the slice is promoted (see
  `knowledge-promotion.md`) before the slice closes.
