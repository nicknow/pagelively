# AGENTS.md

This is the **pagelively** repository: a single-user, Cloudflare-hosted static content
publisher (Worker + R2 + D1 + Cloudflare Access). This file is only an entry point — the real
knowledge lives in the docs below.

## Read first, in this order

1. `docs/product-spec.md` — the authoritative spec (what we build and why).
2. `.ai/knowledge-management.md` — how the repository is organized (`docs` / `.ai` / `.work`).
3. `.ai/team-brief.md` — the full team process, roles, boundaries, and review gates.

## Where things live

- `docs/` — **permanent project knowledge**: how the software works (architecture, API,
  development, operations, ADRs). Commit anything a future developer or agent will benefit from.
- `.ai/` — **permanent agent knowledge**: how an agent should work here (`prompts/`,
  `standards/`, `workflows/`). References `docs/`, never duplicates it.
- `.work/` — **disposable per-role scratch** (`planner`, `architect`, `implementer`,
  `validator`, `reviewer`). Git-ignored, never a dependency between roles. Promote durable
  knowledge into `docs/` or `.ai/`; delete the rest.

## How to work here

- Before writing code, read the standards and workflows in `.ai/standards/` and `.ai/workflows/`.
- Work in small, **test-first vertical slices**; run all gates (test, typecheck, lint, format,
  coverage) before finishing; commit with Conventional Commits on feature branches.
- The build team **never touches Cloudflare**: `cfapi` tools are denied; everything runs against
  local emulation (the Vitest Workers pool — workerd + Miniflare). Verify every Cloudflare fact
  against current official docs (`cfdocs`), never from memory.
- **Never commit secrets.** Only placeholders live in the repo (`.env.example`,
  `.dev.vars.example`); real values exist only in the human's environment at deploy time.

## Boundaries

- Deploying, provisioning, and real Cloudflare API calls are **human-run only** (`setup.mjs`),
  via the separate `deployer` agent — the only agent allowed to reach Cloudflare, and only with
  per-call human approval.
- New capability ideas belong in the open-questions log / roadmap, never silently in code.
- Ambiguity in the spec: record it with options and a recommendation; surface anything
  architectural, security-relevant, or user-visible to the human and wait.

The OpenCode harness (agent definitions, MCP wiring, `cfapi: deny`) lives at the repository's
parent folder in `.opencode/` — see `.ai/team-brief.md` Part C.
