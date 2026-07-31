# Decision log (`docs/adr/`)

Every significant decision is recorded as an **Architecture Decision Record (ADR)** so future
humans and agents can see _why_ the code is the way it is. Cloudflare platform facts are
verified against current official documentation and cited in the ADR — never asserted from
memory.

## ADRs

| #    | Title                                                                                                            | Status   |
| ---- | ---------------------------------------------------------------------------------------------------------------- | -------- |
| 0001 | [Phase 0 foundations: repo layout, toolchain, devcontainer](0001-phase-0-foundations.md)                         | Accepted |
| 0002 | [Language, runtime, and dependency policy](0002-language-runtime-dependency-policy.md)                           | Accepted |
| 0003 | [Test framework and binding emulation](0003-test-framework-binding-emulation.md)                                 | Accepted |
| 0004 | [Devcontainer](0004-devcontainer.md)                                                                             | Accepted |
| 0005 | [Error handling and authentication fail-closed policy](0005-error-handling-auth-fail-closed.md)                  | Accepted |
| 0006 | [Caching model and the `rev` cache-busting scheme](0006-caching-rev-model.md)                                    | Accepted |
| 0007 | [Slugs and reserved words](0007-slugs-reserved-words.md)                                                         | Accepted |
| 0008 | [Serve-time `<base>` injection](0008-serve-time-base-injection.md)                                               | Accepted |
| 0009 | [Cache emulation seam — Workers Caching contract tests](0009-cache-emulation-seam.md)                            | Accepted |
| 0010 | [S01 implementation details — id generation, slugify, route classification](0010-s01-id-slug-router-details.md)  | Accepted |
| 0011 | [S02 implementation details — `validateSlug` reserved-word validation](0011-s02-validate-slug-reserved-words.md) | Accepted |
| 0012 | [S03 implementation details — rev bump policy and the R2 key builder](0012-s03-rev-bump-policy-key-builder.md)   | Accepted |

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
