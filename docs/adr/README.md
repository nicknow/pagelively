# Decision log (`docs/adr/`)

Every significant decision is recorded as an **Architecture Decision Record (ADR)** so future
humans and agents can see _why_ the code is the way it is. Cloudflare platform facts are
verified against current official documentation and cited in the ADR — never asserted from
memory.

## ADRs

| #    | Title                                                                                    | Status   |
| ---- | ---------------------------------------------------------------------------------------- | -------- |
| 0001 | [Phase 0 foundations: repo layout, toolchain, devcontainer](0001-phase-0-foundations.md) | Accepted |

## How to write an ADR

1. Copy the template below into `NNNN-short-title.md` (next number).
2. Fill in **Context** (what problem/decision and why now), **Decision** (what we chose, with
   evidence/citations), **Consequences** (trade-offs, what this enables or forecloses).
3. Keep it to the point; link to code and docs rather than repeating them.

```markdown
# NNNN: <title>

- Status: proposed | accepted | superseded by NNNN
- Date: <YYYY-MM-DD>

## Context

<what prompted the decision; options considered>

## Decision

<what was chosen and why; citations to official docs for platform facts>

## Consequences

<trade-offs; what this enables or forecloses>
```
