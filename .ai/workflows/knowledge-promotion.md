# Workflow: knowledge promotion

The rule, from `.ai/knowledge-management.md`:

> If future developers or future AI agents will benefit from the information, commit it.
> If the information is only useful while solving the current task, place it in the temporary
> workspace.

`.work/` is disposable scratch and git-ignored. Durable knowledge must never be stranded there.

## Where knowledge goes

| Kind of knowledge                                                                | Home                               |
| -------------------------------------------------------------------------------- | ---------------------------------- |
| How the software works: architecture, contracts, data model, behavior, decisions | `docs/`                            |
| How to run/build/test/deploy: local loop, ops, runbook, smoke-test checklist     | `docs/`                            |
| Agent operating knowledge: prompts, standards, workflows, process lessons        | `.ai/`                             |
| Notes only useful for the current task                                           | `.work/<role>/` (delete when done) |

## How to promote

1. When a discovery, decision, or convention would help the next human or agent, write it into
   the appropriate `docs/` or `.ai/` file during the slice (docs travel with the behavior).
2. Cross-link: reference related docs/ADRs; `.ai/` references `docs/`, never duplicates it.
3. Record significant decisions as ADRs in `docs/adr/` with citations for Cloudflare platform
   facts.
4. Clean the corresponding `.work/` scratch when the slice closes.

## Anti-patterns

- Leaving authoritative knowledge only in scratch (it is invisible to the next clone).
- Duplicating `docs/` content into `.ai/` (the two must not drift).
- Copying scratch _into_ docs wholesale (write for the reader, not the session).
