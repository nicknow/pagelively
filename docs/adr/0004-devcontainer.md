# 0004: Devcontainer

- Status: accepted
- Date: 2026-07-31

## Context

The brief requires a devcontainer in which `install → build → typecheck → lint → test` all run
from a clean container with zero cloud setup (reproducibility requirement), and asks for an
ADR. Phase 0 already chose and verified the image (ADR 0001 §4); Phase 2 re-affirms it as the
lock-in with the Node-version rationale current.

## Decision

1. **Image**: `mcr.microsoft.com/devcontainers/typescript-node:5.0.3-24-bookworm` — Node 24
   (Active LTS at Phase 0), Debian bookworm. Exact tag verified against the MCR tag registry
   in Phase 0.
2. **Node version policy**: Wrangler supports the Current, Active, and Maintenance Node
   releases (verified:
   <https://developers.cloudflare.com/workers/wrangler/install-and-update/>); pinning the
   Active LTS (Node 24) matches both the supported range and stability. `package.json` engines
   `>= 22` keeps the floor explicit for out-of-container use.
3. **`postCreateCommand`**: `npm install && npm run db:local:migrate` — dependencies in and
   the local D1 schema applied on first boot, so `npm test` works immediately (the pool's
   migrations-in-tests setup also applies them per test file).
4. **Port 8787** forwarded for the `wrangler dev` local loop.
5. **No Cloudflare credentials** in the image or config; `.env.example` / `.dev.vars.example`
   hold placeholders only (ADR 0001 placeholder policy).

## Consequences

- A fresh clone + devcontainer reproduces the whole toolchain with no accounts and no
  network-dependent Cloudflare state — the reproducibility requirement holds.
- The human's local loop is documented in `docs/development/` (provisioning/deploy are
  separate, human-run steps; see `docs/operations/`).
- Devcontainer drift is tracked as risk R13 (tooling); upgrading the image requires an ADR
  note, not a silent bump.
