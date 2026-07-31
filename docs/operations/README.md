# Operations (`docs/operations/`)

Everything a human needs to provision, deploy, and run Pagelively for real.

**Status: not yet written.** Produced alongside the `setup.mjs` slice and the final validation
phase. Planned contents:

- **Provisioning guide** — required API token scopes, `npm run setup` walkthrough, idempotency
  notes (spec §13).
- **Deploy** — GitHub Actions path, custom domains, Cloudflare Access configuration.
- **Operator smoke-test checklist** — the infra seams that cannot be unit-tested (R2-CDN
  public serving, live Access, custom domains) verified against the real deployment.
- **Runbook** — troubleshooting, rotating tokens, "re-render all" maintenance, cleanup.

The build team never provisions or deploys; this section is written _for_ the human (and the
`deployer` agent) who does.
