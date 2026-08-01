# 0021: S12 — Entry request pipeline

- Status: accepted
- Date: 2026-07-31

## Context

Slice S12 wires the previously built pure pieces (router, redirects, home
resolution, base injection, D1 repository, R2 object store, cache headers) into
the real `src/index.ts` request handler. The decisions were small but worth
recording because they affect the public surface, error handling, and the seam
between the handler and the cache service.

## Decision

1. **`src/index.ts` is a thin router, not a library.** It classifies the path,
   applies the trailing-slash redirect, dispatches to `serveEntry` for public
   page routes, returns placeholder responses for `/admin*` and `/api*`, and
   wraps everything in a single `try/catch` (spec §5, §11; architecture 02).

2. **`serveEntry(request, deps)` is the only public-serving handler.** It
   resolves `/{slug}/` and `/p/{id}/` through the D1 repository, returns a clean
   404 for missing rows, and branches on `page.kind`:
   - `image` → 301 redirect to `{ASSET_BASE_URL}/pages/{id}/{rev}/{entry_path}`.
   - `html`, `markdown`, `bundle` → fetch the entry HTML from R2, inject the
     `<base href="...">` tag via S04, and return it with `text/html; charset=utf-8`.
     Markdown entries are already rendered HTML at publish time (S17), so the
     renderer is not invoked at serve time.

3. **`CacheService` is the single seam for cache behavior.** Public handlers
   receive a `CacheService` instance created from `env`. `headersFor` is the pure
   S07 function; `purgePage`/`purgePages` use `ctx.cache.purge({ tags: [...] })`
   (verified via Cloudflare docs: `ctx.cache.purge` is the documented API). In
   S12 the purge methods are real but not yet exercised by the public routes;
   S13 will use them after mutations.

4. **`createConfig(env)` centralizes env normalization.** All env reads happen
   in one module. It strips trailing slashes from `ASSET_BASE_URL`, trims and
   lowercases `HOME_MODE`, treats every non-`"page"` value as `"404"`, and stores
   `access.aud` as `null` when the value is empty or a placeholder (all zeros).
   This fail-safe default ensures the S16 JWT gate closes when the operator has
   not yet run setup.

5. **`toErrorResponse` maps `AppError` to a generic JSON response.** It exposes
   only the stable error code, never the stack or internal detail. The caller
   attaches the cache headers (`error` route class = `no-store`). Non-`AppError`
   exceptions become `{ error: "internal_error" }` 500s with `no-store`.

6. **Home mode is served directly at `/` via a synthetic request.**
   `resolveHome` returns a slug, and `index.ts` constructs a `Request` for
   `/{slug}/` and calls `serveEntry`. This reuses the same slug resolution,
   base injection, and cache-header logic without a redirect (OQ-08).

7. **Admin/API routes are recognized but not implemented.** S12 returns a
   placeholder `404` JSON `{ error: "not implemented" }` with `no-store` headers
   for every `/admin*` and `/api*` path. The real handlers (S15–S19) will
   replace this dispatch branch.

## Consequences

- The public pipeline is fully testable end-to-end against local D1 + R2
  emulation without any Cloudflare credentials.
- `serveEntry` remains binding-agnostic: it depends only on the repository and
  object-store interfaces, so both production and tests can inject fakes.
- The error boundary never leaks stack traces or raw database/R2 messages to
  clients, satisfying the security posture from ADR 0005.
- Keeping purge on the `CacheService` seam means S13 only needs to call the
  existing methods; the handlers do not need to know about `ctx.cache`.

## Cross-references

- Spec: §5 (URL & routing), §6 (base injection), §11 (public serving, caching),
  §12 (configuration).
- Docs: `docs/architecture/02-module-boundaries-contracts.md` (handler
  contracts), `docs/architecture/04-caching-rev-model.md`.
- ADRs: 0005 (error handling), 0006 (caching/rev), 0008/0013 (base injection),
  0009 (cache seam), 0017 (redirects), 0018 (home mode).
- Code: `src/index.ts`, `src/entry-serve.ts`, `src/config.ts`,
  `src/cache-service.ts`, `src/errors.ts`.
