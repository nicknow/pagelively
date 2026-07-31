# Documentation index (`docs/`)

`docs/` answers **"how does the software work?"** — permanent, authoritative, committed
knowledge for humans and agents. Agent operating knowledge (how an _agent_ should work here)
lives in `.ai/` instead.

| Path                                 | Answers                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| [`product-spec.md`](product-spec.md) | **What we are building.** The authoritative spec (source of truth; do not deviate).                                                     |
| [`architecture/`](architecture/)     | How the pieces fit together: module boundaries, data model, caching/`rev` model, test strategy. _(Produced in the architecture phase.)_ |
| [`api/`](api/)                       | The admin API and the public routes (request/response contracts).                                                                       |
| [`development/`](development/)       | How to run, build, test, and debug locally: devcontainer, local loop, testing approach.                                                 |
| [`operations/`](operations/)         | Provisioning, deploy, the operator smoke-test checklist, the runbook.                                                                   |
| [`adr/`](adr/)                       | The decision log: every significant decision as an Architecture Decision Record, with citations.                                        |

## Writing rules

- Write for a reader who has never seen the repo. Explain _why_, not just _what_.
- Anything durable discovered during work is **promoted** here from `.work/` (see
  `.ai/workflows/knowledge-promotion.md`).
- `.ai/` references these docs; it never duplicates them.
