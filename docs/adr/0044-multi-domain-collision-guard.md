# 0044: Multi-domain collision guard in setup.mjs

- Status: accepted
- Date: 2026-08-04

## Context

`setup.mjs` (ADR 0029, ADR 0033, ADR 0035) derives Cloudflare resource names deterministically from `projectName` — the R2 bucket is `{project}-assets`, the D1 database is `{project}-db`, the KV namespace is `{project}-kv`, the Worker name is `{project}`, and the Access application is `{project} admin`. If a human runs `npm run setup` for a **second** domain with the **same** `projectName`, the script's idempotency-by-name logic (ADR 0029 §3) finds the existing resources and reuses them silently.

This produces a dangerous collision: the Worker script runs on a different custom domain than the one it was originally provisioned for, but environment variables from the first domain's `wrangler.toml` remain unchanged. The R2 bucket's CDN custom domain similarly stays pointed at the first domain. The operator gets no warning that resource names collide across domains — the bucket, database, and Worker are shared, but the `wrangler.toml` contents are not.

The collision also violates the single-tenant model intended by the spec: each `projectName` + domain pair should be an independent deployment with its own resources.

A related but less severe risk is that a bucket might already be connected to a completely different CDN domain (e.g. a pre-existing bucket reused by accident), or that the Worker already has a custom domain for another hostname (e.g. a second Worker deployment with the same name but different routing).

Two responses were considered but rejected:

1. **Interactive confirm prompt.** "Worker already has a domain pointing at X. Re-run for Y? (y/N)". This hangs in headless CI (GitHub Actions `deploy.yml`, ADR 0030) where there is no TTY. The script would need to detect TTY presence and fall back differently, creating two divergent failure modes.

2. **Local state comparison.** Comparing `wrangler.toml` contents against remote state would be fragile: the local file is uncommitted, may be dirty from a previous run, and is the very file being written by setup. Restoring detection from a local file is unreliable.

## Decision

Add a **collision guard** that runs as the first remote check inside `runSetup`, before touching any Cloudflare resources. The guard queries two Cloudflare API endpoints and compares every returned domain against the domains the operator intends for this run. If any domain mismatch is detected, the script aborts with a clear error listing the conflicting resource, its current domain, and the intended domain — unless the operator has explicitly opted in via `SETUP_ALLOW_REPOINT` / `opts.allowRepoint`.

### Detection heuristic

**Worker custom domain check.** Before creating or updating any resource, call:

```
GET /accounts/{accountId}/workers/domains?service={workerName}
```

The API reference at `developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/` (verified via `cfdocs`) documents the response schema:

- `result`: array of objects — each object carries `hostname` (the domain), `service` (the Worker name), `zone_id`, `zone_name`, etc.
- `service` is the name of the Worker associated with the domain.
- `hostname` is the configured domain.

The guard iterates `result[]` and for each entry where `result[i].hostname !== workerDomain` (the domain the operator specified for this run), it reports a collision.

**Rationale:** The Worker custom domain is the primary collision vector. If `{project}` already serves a different domain (e.g. `blog.example.com` from a previous run for `projectName=blog`), and the operator now runs setup for `projectName=blog` targeting `blog.other.com`, the guard catches it because the `hostname` field mismatches the intended `workerDomain`. Rerunning for the same domain is silent — the `hostname` matches and the guard does nothing.

**R2 custom domain check.** Call:

```
GET /accounts/{accountId}/r2/buckets/{bucketName}/domains/custom
```

The API reference at `developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/custom/methods/list/` (verified via `cfdocs`) documents:

- `result.domains`: array of objects — each object carries `domain` (the custom domain hostname), `enabled` (boolean), status, zone metadata.
- `enabled` indicates whether the bucket is publicly accessible at that domain.
- `domain` is the hostname string.

The guard iterates `result.domains[]`, filters to only `enabled === true` domains, and for each where `domain !== cdnDomain` (the bucket's CDN domain the operator specified), it reports a collision.

**Rationale:** An R2 bucket could already be connected to a CDN domain from a previous deployment or from manual dashboard configuration. Even if the Worker custom domain is clean (e.g. the Worker has no custom domains yet), the bucket may leak content via the wrong CDN domain. Only `enabled` domains are checked because disabled/removed domains pose no active risk — the bucket is not publicly accessible through them.

### Why no D1 or KV check

D1 databases are referenced by ID in `wrangler.toml` (`database_id`); they have no domain binding. A reuse of the same D1 database is intentional (it is the same data). KV namespaces are similarly ID-referenced with no domain binding. Both are created/bound before the collision guard runs in the existing setup order (ADR 0029 confirms resource creation steps), but since the guard runs as the **first** remote call — before any resource creation — and D1/KV have no domain-level collision surface, no separate checks are needed. The Worker and R2 domain checks are sufficient because all cross-domain interference flows through those two domain bindings.

### Override mechanism

`SETUP_ALLOW_REPOINT` (env var, also mapped into `opts.allowRepoint` in `envToSetupOptions`) explicitly opts the operator out of the guard. This is **not** a soft confirm prompt — it is a declaration passed as part of the setup options, available in both interactive and headless modes. The override is appropriate when the operator is deliberately repointing a `projectName` from one domain to another (e.g. migrating `blog.example.com` to `blog.other.com`) and accepts that the old domain's content paths will now serve the new deployment.

In headless mode (`SETUP_ACCESS_TEAM_DOMAIN` is set, no TTY), the guard fails identically to interactive mode — no prompt, no hang. The same `SETUP_ALLOW_REPOINT` override works in both modes.

### Failure message

When a collision is detected, the script:

1. Lists every conflicting resource with current → intended domain.
2. Logs: `"Collision detected: resource <type> '<name>' is already bound to domain '<current>', but setup expects '<intended>'. Set SETUP_ALLOW_REPOINT=true or pass allowRepoint:true to skip this check."`
3. Returns early (no throw — consistent with the "clear pre-deploy error" pattern from ADR 0029 §5 and ADR 0035). The script exit code is non-zero so CI fails.

### Stateless detection

The guard queries remote state only — no local `wrangler.toml` reads, no cache, no stored fingerprints. This means:

- It works identically regardless of whether `wrangler.toml` has been edited, is missing, or has stale comments.
- It detects collisions that were created outside setup.mjs (dashboard manual configuration, another script, Wrangler CLI).
- It does not depend on any local file being committed or present.

### Idempotent re-run

When the operator runs `npm run setup` for the same domain with the same `projectName`, both guards find matching domains (the Worker's `hostname` equals `workerDomain`, the R2 bucket's `domain` equals `cdnDomain`) and proceed silently. No change in behavior from the current idempotent flow.

## Citations

- Workers domains list API: `developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/` — verified via `cfdocs`; response `result[]` contains `hostname` and `service` fields.
- R2 custom domains list API: `developers.cloudflare.com/api/resources/r2/subresources/buckets/subresources/domains/subresources/custom/methods/list/` — verified via `cfdocs`; response `result.domains[]` contains `domain` and `enabled` fields.
- R2 public buckets and custom domain requirements: `developers.cloudflare.com/r2/buckets/public-buckets/` — verified via `cfdocs`.
- Workder custom domains: `developers.cloudflare.com/workers/configuration/routing/custom-domains/` — multiple custom domains per Worker supported.

## Consequences

- **Safe multi-domain guard.** Running setup for a second domain with the same `projectName` now fails with a clear, actionable error instead of silently sharing resources.
- **Headless-safe.** No interactive confirm prompt; the override mechanism (`SETUP_ALLOW_REPOINT`) works identically in TTY and non-TTY environments.
- **Zero state overhead.** No local cache, no stored fingerprints, no `wrangler.toml` parsing — the guard always queries the live API.
- **Two extra API calls per setup run.** These are GET requests against the account-level Workers domains endpoint and the R2 bucket domains endpoint. Both are lightweight paginated lists with no side effects. Latency is negligible compared to the subsequent resource creation calls and `wrangler deploy`.
- **False positive edge case: multiple Worker custom domains intended.** If an operator deliberately configures a Worker with multiple custom domains (the Workers custom domains docs confirm multiple custom domains per Worker are supported), the guard will flag the second domain as a collision. This is intentional — setup.mjs provisions a single Worker with a single custom domain; multi-domain deployments are outside scope and should be managed directly via the Cloudflare dashboard or Wrangler. If this use case emerges, the guard can be scoped by checking whether any of the Worker's domains match `workerDomain` rather than requiring exact equality.
- **Coverage note:** The collision guard is a live-API concern and is tested via the existing mock-API injection seam (ADR 0029 §1). Unit tests supply mocked responses for the Workers domains list and R2 custom domains list endpoints to cover collision-detected, collision-clear, and empty-return paths. The end-to-end behaviour — including the exact error message and the `SETUP_ALLOW_REPOINT` opt-out — is validated in the existing Vitest setup test suite (`test/setup*.test.ts`). No live Cloudflare account is needed in CI.
