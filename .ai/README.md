# Agent knowledge (`.ai/`)

`.ai/` answers **"how should an AI agent work in this repository?"** — reusable prompts,
standards, and workflows. It references `docs/` (which answers "how does the software work?")
rather than duplicating it.

## Structure

| Path                          | What it is                                                                                                                        |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `knowledge-management.md`     | The discipline behind this layout (`docs` / `.ai` / `.work`): the canonical article.                                              |
| `team-brief.md`               | The full team process: roles, workflow, boundaries, review gates. Read it.                                                        |
| `prompts/`                    | Reusable role prompts — the durable form of the OpenCode agent definitions (`.opencode/agent/*.md`, which live outside the repo). |
| `standards/`                  | Coding standards, test standards, commit conventions, Definition of Done.                                                         |
| `workflows/`                  | The per-slice implementation loop, the testing loop, the knowledge-promotion rule.                                                |
| `scratch/`, `cache/`, `logs/` | Disposable working areas (git-ignored; only the READMEs are tracked).                                                             |

## The three folders, at a glance

- **`docs/`** — permanent project knowledge. _If a future developer or agent will benefit, commit it here._
- **`.ai/`** — permanent agent knowledge. _Same rule, for how agents work._
- **`.work/`** — disposable per-role scratch. _If it is only useful for the current task, it stays here — and gets cleaned up._

## Operating rules (the non-negotiables)

1. Read, in order: `docs/product-spec.md`, `.ai/knowledge-management.md`, `.ai/team-brief.md`.
2. Work in small, test-first vertical slices; every gate green (test, typecheck, lint, format,
   coverage); Conventional Commits on feature branches.
3. **Never touch Cloudflare.** `cfapi` tools are denied to the build team. Everything runs
   against local emulation. Verify any Cloudflare fact against current official docs (`cfdocs`),
   never memory. Deploy/provisioning are human-run only.
4. **Never commit secrets.** Placeholders only.
5. Promote durable knowledge out of `.work/` into `docs/` or `.ai/`; never leave authoritative
   knowledge stranded in scratch; never depend on another role's scratch.
6. Ambiguity: record options + recommendation in the open-questions log; surface anything
   architectural, security-relevant, or user-visible to the human and wait.
