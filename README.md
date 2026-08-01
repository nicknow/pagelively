# Pagelively

A single-user, Cloudflare-hosted **static content publisher**: upload HTML files,
Markdown files, and images (individually or as folder bundles) and serve them publicly by a
short **id** or a friendly **slug** — free on Cloudflare's free tiers. Asset bytes are served
straight from an R2 custom domain (free, unlimited bandwidth); the Worker is only in the path
for the entry document; admin access is protected by Cloudflare Access.

- **What we build:** [`docs/product-spec.md`](docs/product-spec.md) — the authoritative spec.
- **Architecture:** [`docs/architecture/`](docs/architecture/) (produced in the architecture phase).
- **Local development:** [`docs/development/`](docs/development/) — devcontainer, local loop, testing.
- **Operations & deploy:** [`docs/operations/`](docs/operations/) — provisioning and the operator
  smoke-test checklist (written for the human who runs the real deploy).
- **Decisions:** [`docs/adr/`](docs/adr/) — the decision log.

## Status

**Phase 1 — S01–S19 feature work complete; S20 setup script implemented.**
Remaining: S21 GitHub Actions workflow and S22 end-to-end smoke test closeout.

## Quickstart (devcontainer)

1. Open the repo in a dev container (see [`docs/development/`](docs/development/)).
   The container preinstalls Node 24 LTS, installs dependencies, and prepares the local D1
   database automatically.
2. `npm test` — the full suite runs against **local emulation** (workerd + Miniflare): no
   Cloudflare account, no credentials, nothing to configure.
3. `npm run dev` — local dev loop at <http://localhost:8787> (`GET /health` returns the
   liveness check).

All gates: `npm run typecheck && npm run lint && npm run format:check && npm test`.

## Quickstart (provision and deploy)

1. **Prerequisites**: Cloudflare account, target domain added as a zone, Zero Trust initialized.
2. Create a Cloudflare API token with the scopes listed in
   [`docs/operations/README.md`](docs/operations/README.md).
3. `npm install`
4. `export CLOUDFLARE_API_TOKEN="your-token"` (or skip this and use `wrangler login` at the
   prompt).
5. `npm run setup` — idempotently provisions resources, writes `wrangler.toml`, applies D1
   migrations, and deploys.
6. Visit the live URL, admin URL, and CDN URL printed by the script.

Re-running `npm run setup` is safe. See the operator checklist at
[`docs/operations/smoke-test-checklist.md`](docs/operations/smoke-test-checklist.md).

## Provisioning & deploy (human-run, not part of the build)

`npm run setup` runs `setup.mjs`, which idempotently provisions the R2 bucket, D1 database,
optional KV namespace, Cloudflare Access application + policy, and both custom domains, then
deploys. **The build team never deploys or touches Cloudflare**; provisioning happens only
after review, with your own credentials, following the checklist in
[`docs/operations/`](docs/operations/).
