# `.work/` — disposable scratch

Per-role workspaces for temporary work-in-progress. **Everything here is git-ignored** and may
be deleted at any time.

- Never reference `.work/` from code, docs, or another role's work.
- Promote anything durable to `docs/` (project knowledge) or `.ai/` (agent knowledge) before
  cleaning up — see `.ai/workflows/knowledge-promotion.md`.
- One directory per role: `planner/`, `architect/`, `implementer/`, `validator/`, `reviewer/`.
  Each contains a short README explaining that role's scratch.
