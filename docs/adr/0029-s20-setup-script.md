# 0029: S20 — setup.mjs provisioning script

- Status: accepted
- Date: 2026-08-01

## Context

`docs/product-spec.md` §13 requires a human-run, cross-platform Node.js provisioning script (`setup.mjs`) that idempotently creates the Cloudflare resources needed for Pagelively (R2 bucket, D1 database, optional KV namespace, Cloudflare Access application + policy, R2 CDN custom domain), writes the resulting IDs and URLs into `wrangler.toml`, applies D1 migrations, and deploys the Worker.

This slice is the boundary between the build team's local-only work and the real Cloudflare account. The script must therefore be:

- **Testable without an account.** The build team must never call live Cloudflare APIs in CI.
- **Idempotent and resumable.** A human re-running the script after a partial failure must not create duplicate resources or have to start from scratch.
- **Cross-platform.** The same script runs on Linux, macOS, and Windows (Node.js ES module, no shell-specific commands).

## Decision

1. **Dependency injection for testability.** `setup.mjs` exports a `runSetup(options, deps)` function that receives all external seams (`api`, `wrangler`, `fs`, `prompt`, `confirm`, `log`, `pause`). The CLI entry point builds a real Node.js-based implementation and calls `runSetup`. The Vitest suite imports `runSetup` and passes mocks, so the script's real API calls are exercised in code but never hit Cloudflare in tests.

2. **Cloudflare REST API for resource CRUD.** `setup.mjs` uses the Cloudflare REST API (`/accounts/{account_id}/...`) for listing and creating R2 buckets, D1 databases, KV namespaces, and Access applications/policies. Wrangler is reserved for the operations that only it can do: `wrangler login` (when no API token), `wrangler d1 migrations apply`, and `wrangler deploy`. This keeps the script idempotent: list-then-create for each resource, and re-running skips existing resources. Platform facts were verified against current Cloudflare docs (see citations below).

3. **Idempotency by name.** The script finds resources by the deterministic names it derives (`{project}-assets`, `{project}-db`, `{project}-kv`, `{project} admin`). If a resource exists, it reuses it and skips the create call. If a step failed previously, the next run sees the already-created resources and continues from where it left off.

4. **Zero Trust not initialized → pause, not fail.** If the Access apps list returns a 403/not-initialized error, the script logs the one-time setup steps and waits for the user to press Enter, returning without deploying. It never tries to create an Access application before Zero Trust is ready.

5. **Missing zone → clear pre-deploy error.** Before deploy, the script verifies that both the Worker domain and the CDN domain are zones in the account. If either is missing, it logs a clear error and returns without calling `wrangler deploy`.

6. **wrangler.toml update by targeted replacement.** The script preserves the existing file and comments by replacing known placeholder values with regex (`database_id`, `bucket_name`, vars, etc.) and appending a `[[routes]]` block for the Worker custom domain if not present. The optional KV namespace block is uncommented when KV is provisioned. Replacement strings are passed as functions (`() => `...${value}...``) rather than string literals, so any `$`characters in user-derived values (e.g.,`ASSET_BASE_URL`, `ACCESS_TEAM_DOMAIN`, `workerDomain`) are written literally and never interpreted as `String.replace` special patterns (`$&`, `$$`, `$1`, etc.).

7. **Token vs interactive auth.** If `CLOUDFLARE_API_TOKEN` is present, the script uses it. Otherwise it prompts for `wrangler login`. The auth method is overridable via `options` for tests.

8. **Human-run only.** The script is excluded from the automated test coverage (`vitest.config.mts` includes only `src/**`). The real CLI entry point is only invoked by a human (or the separate `deployer` agent with per-call approval). Tests cover the injected logic.

## Citations

- Cloudflare Access application API shape and `aud` tag: `developers.cloudflare.com/cloudflare-one/access-controls/applications/linked-app-token/` (verified via `cfdocs`).
- R2 public buckets and custom-domain requirements: `developers.cloudflare.com/r2/buckets/public-buckets/` (verified via `cfdocs`).
- Worker custom domains via `wrangler.toml`: `developers.cloudflare.com/workers/configuration/routing/custom-domains/` (roadmap §6).
- D1 migration commands: `developers.cloudflare.com/d1/reference/migrations/` (roadmap §6).

## Consequences

- The script is fully unit-testable with mocks and does not need a Cloudflare account in CI.
- The API endpoint for connecting an R2 bucket custom domain (`/accounts/{account_id}/r2/buckets/{bucket_name}/domains/custom`) was verified on the first real run against the live API and the official schema (`developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/custom/methods/create/`): the request body requires `domain` and `zoneId` (camelCase — the initial `zone_id` guess was rejected with HTTP 400), and `enabled` is optional (defaults to true). The failure path surfaces the API `errors[]` body via `describeApiError` (field fix 2026-08-01).
- The Access application is created and reconciled with an exact path scope of `${workerDomain}/admin` and `${workerDomain}/api` (field fix 2026-08-01). Initial provisioning used `domain: workerDomain` with no path, which scopes the app to the **entire** worker domain — a live bug where Access prompted on every public content URL (e.g. `https://n.3a8r.com/sadds-sdsd/`). The fix: the create call sends `domain: <host>/admin` plus `destinations: [{type:"public",uri:<host>/admin},{type:"public",uri:<host>/api}]` (`destinations` supersedes the deprecated `self_hosted_domains` field), and a legacy whole-domain app found by name+host is repaired **in place** with `PUT /accounts/{account_id}/access/apps/{app_id}` — the app id, and therefore its `aud` tag, is stable, so the existing `ACCESS_AUD` in `wrangler.toml` keeps working. `policies` is deliberately omitted from the PUT (the allow-admins policy is re-verified separately). Facts verified against the official Access application create/update API references and the app-paths doc (path `example.com/admin` covers `/admin` and everything under it, but not `/administrator`): `developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/` (and `.../methods/update/`), `developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/`. Reconcile repairs only the **first** matching application (`Array.find`, not a filter), so a residual duplicate whole-domain application on the same host would be caught by the smoke-test checklist's public-URL check rather than auto-repaired.
- The script is intentionally not run automatically in CI. A human (or the `deployer` agent) runs it after review.
- Because the script edits `wrangler.toml` in place, it must be committed with placeholders; the real values are written locally at provision time and must never be committed.
