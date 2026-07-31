# Local development (`docs/development/`)

How to get from a fresh clone to a running, tested local copy of Pagelively — with **zero
cloud setup**. All storage (D1, R2, KV) is emulated locally by Wrangler (Miniflare + workerd).
No Cloudflare account or credentials are ever needed during development.

## Prerequisites

Only one: **a container runtime** (Docker/Podman). The devcontainer pins Node 24 (Active LTS,
matching Wrangler's supported range) and preinstalls npm, Wrangler (as a dev dependency), and
the test toolchain.

## Open the devcontainer

- **VS Code:** install the "Dev Containers" extension → "Reopen in Container".
- **CLI:** `devcontainer` / `docker` tooling of your choice against `.devcontainer/devcontainer.json`.

On first boot the container runs `npm install` and prepares the local D1 database
(`npm run db:local:migrate`), so `npm test` works immediately.

## The local loop

| Command                                 | What it does                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                           | `wrangler dev` — local Worker at <http://localhost:8787> (port 8787 is forwarded). D1/R2 bindings are emulated. |
| `npm test`                              | Full test suite (Vitest Workers pool — tests run _inside_ workerd).                                             |
| `npm run test:watch`                    | Watch mode for the test loop.                                                                                   |
| `npm run test:coverage`                 | Suite + coverage report (threshold set by ADR in the architecture phase).                                       |
| `npm run typecheck`                     | `tsc` on both `src/` and `test/`.                                                                               |
| `npm run lint` / `npm run format:check` | ESLint / Prettier gates.                                                                                        |
| `npm run build`                         | Bundle check (`wrangler deploy --dry-run`) — proves the Worker bundles, without deploying.                      |
| `npm run db:local:migrate`              | Apply any new D1 migrations to the local emulation (also run on container boot).                                |

Smoke target: `GET http://localhost:8787/health` → `{"ok": true, ...}`.

## How tests emulate the platform (summary)

- **Runner:** Vitest with the Workers pool (`@cloudflare/vitest-pool-workers`) — Cloudflare's
  recommended unit-test tooling; tests execute inside `workerd`.
- **D1:** the real `migrations/*.sql` are applied to each test file's isolated local database
  in test setup, and tests assert against the real schema.
- **R2:** local object emulation via the pool's Miniflare storage; tests assert puts/gets and
  the `pages/{id}/{rev}/…` key layout.
- **Cloudflare Access:** no real Access needed — the Worker's JWT verification is unit-tested
  with locally generated keypairs and a mock JWKS (valid / expired / wrong-`aud` / tampered).

Details and decisions: see the architecture docs and ADRs (`docs/architecture/`,
`docs/adr/`). The slice-by-slice roadmap lives at `docs/development/roadmap.md` (produced in
the planning phase).

## Provisioning and deploy are separate

Everything above is local-only. Provisioning real resources and deploying (`npm run setup`,
`wrangler deploy`, Cloudflare Access, the R2 CDN domain) is a **human-run** step with your own
credentials — see `docs/operations/`. The build never does it.
