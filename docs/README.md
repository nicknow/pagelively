# Documentation index (`docs/`)

`docs/` answers **"how does the software work?"** — permanent, authoritative, committed
knowledge for humans and agents. Agent operating knowledge (how an _agent_ should work here)
lives in `.ai/` instead.

| Path                                 | Answers                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| [`guide/`](guide/)                   | **How to use it.** Signing in, publishing pages, editing, troubleshooting — for the person running a deployment. |
| [`product-spec.md`](product-spec.md) | **What we are building.** The authoritative spec (source of truth; do not deviate).                              |
| [`architecture/`](architecture/)     | How the pieces fit together: module boundaries, data model, caching/`rev` model, test strategy.                  |
| [`api/`](api/)                       | The admin API and the public routes (request/response contracts).                                                |
| [`development/`](development/)       | How to run, build, test, and debug locally: devcontainer, local loop, testing approach.                          |
| [`operations/`](operations/)         | Provisioning, deploy, the operator smoke-test checklist, the runbook.                                            |
| [`adr/`](adr/)                       | The decision log: every significant decision as an Architecture Decision Record, with citations.                 |

## Terms you'll see throughout these docs

- **ADR** — Architecture Decision Record: a short, permanent write-up of one significant
  decision (what was chosen, why, what it trades off). See [`adr/`](adr/).
- **Slice (`S01`, `S16`, …)** — this project was built in small, ordered units of work called
  slices; ADRs and commit messages reference them (e.g. "S16" = the slice that added Access JWT
  verification). They're a build-history label, not something you need to track day to day.
- **OQ (`OQ-15`, …)** — "open question": a design question raised during planning and later
  resolved, referenced from ADRs and [`development/roadmap.md`](development/roadmap.md) for
  traceability.
- **`rev`** — an internal per-publish revision counter used for cache-busting (see
  [`architecture/04-caching-rev-model.md`](architecture/04-caching-rev-model.md)); not something
  you manage directly.

## Writing rules

- Write for a reader who has never seen the repo. Explain _why_, not just _what_.
- Anything durable discovered during work is **promoted** here from `.work/` (see
  `.ai/workflows/knowledge-promotion.md`).
- `.ai/` references these docs; it never duplicates them.
