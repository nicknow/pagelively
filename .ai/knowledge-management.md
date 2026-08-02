# Knowledge management in this repository

This repo was built primarily by AI coding agents working in defined roles (planner,
architect, implementer, validator, reviewer, deployer — see `.ai/team-brief.md`), often across
many separate sessions with no shared memory between them. Nothing survives from one agent
session to the next except what's actually committed to the repository. That constraint is why
knowledge here is deliberately split into three places, by how long it stays true and who needs
it — not just for AI agents, but for any human joining the project cold.

## The three places

### `docs/` — permanent project knowledge

Answers: **how does the software work, and how do I run/deploy it?**

This is where architecture, the API contracts, the data model, operational runbooks, and the
record of every significant decision live — see [`docs/README.md`](../docs/README.md) for the
current index. It's written for a reader who has never seen the repo before, human or agent,
and it's expected to stay accurate: if a change alters behavior described here, the doc gets
updated in the same commit (see `.ai/standards/commit-conventions.md`).

Concretely: `docs/product-spec.md` is the authoritative "what we're building"; `docs/adr/`
records "why we built it that way"; `docs/architecture/`, `docs/api/`, `docs/development/`, and
`docs/operations/` cover "how it fits together" and "how to run it." `docs/guide/` covers "how
to actually use it" once deployed.

### `.ai/` — permanent agent knowledge

Answers: **how should an agent (or a human following the same process) work in this repo?**

This is process knowledge, not product knowledge: `prompts/` holds the reusable per-role
prompts, `standards/` holds coding/test/commit conventions, `workflows/` holds repeatable
procedures like this one. `.ai/` is allowed to *reference* `docs/` (e.g. "coding standards
follow the toolchain decisions in the ADRs") but must never duplicate its content — if the same
fact lives in both places, one of them will eventually be wrong.

### `.work/` — disposable per-role scratch

Answers: **nothing durable.** `.work/<role>/` (planner, architect, implementer, validator,
reviewer) is where an agent thinks out loud, drafts, and leaves working notes for *itself*
mid-task. It's git-ignored except for the READMEs, and treated as disposable: another role
should never depend on what's sitting in a different role's scratch directory, because that
directory can be wiped without warning.

The rule that governs all three:

> If future developers or future AI agents will benefit from the information, commit it.
> If the information is only useful while solving the current task, place it in the temporary
> workspace.

In practice: a decision, a discovered constraint, or a convention gets written into `docs/` or
`.ai/` *during* the work, not reconstructed later from scratch notes. See
`.ai/workflows/knowledge-promotion.md` for exactly where different kinds of knowledge belong
and how promotion happens slice by slice.

## Multi-agent collaboration

Because multiple agent roles work in this repo (sometimes across parallel branches), a few
rules keep that from turning into cross-role coupling:

- Each role gets its own directory beneath `.work/` and writes only there.
- Temporary files never become another role's dependency — if the implementer needs something
  the planner figured out, that fact should already be in `docs/` or `.ai/`, not read out of
  `.work/planner/`.
- Reusable prompts live in `.ai/prompts/`; reusable procedures live in `.ai/workflows/`. Both
  are shared, versioned, and expected to keep working as the project evolves.

## `AGENTS.md`

`AGENTS.md` at the repo root is the entry point, not the content — it's kept short deliberately
and just points into `docs/` and `.ai/` in the order they should be read. Detailed project
knowledge doesn't belong there; it belongs in the files this document describes.
