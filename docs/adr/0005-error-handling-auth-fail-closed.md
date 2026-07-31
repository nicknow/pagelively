# 0005: Error handling and authentication fail-closed policy

- Status: accepted
- Date: 2026-07-31

## Context

The admin API is the only write path (§9–§13) and sits behind Cloudflare Access; the
application must degrade safely when its own token verification, bindings, or the Access
frontend misbehave. The roadmap (§8) asks for an ADR on the error taxonomy and the auth
failure mode. Verified platform constraints: the Cache API is **not available to Workers
fronted by Cloudflare Access** (<https://developers.cloudflare.com/workers/runtime-apis/cache/>),
and Access guarantees JWTs signed with the team's JWKS
(<https://developers.cloudflare.com/changelog/product/workers/5/>) — so a JWT that fails
verification is _never_ an authenticated request, regardless of Access having proxied it.

## Decision

1. **Single error shape.** `AppError` with `code` (stable machine string), `status` (HTTP),
   `publicMessage` (safe, user-facing), and `detail` (structured, debug-only, redacted).
   Handlers catch, map to `AppError`, and render the JSON error body; anything else hits the
   boundary 500 handler (error boundary at `src/errors.ts`, `docs/architecture/05`).
2. **Status taxonomy** (full table in `docs/architecture/05`): 400 invalid input
   (e.g. slugify/classify failures), 403 all auth failures, 404 unknown page/file, 409 slug
   collision, 413 payload guard, 422 structural content errors, 500 unexpected. **401 is
   deliberately unused** — Access (not the Worker) owns the 401-vs-login decision at the
   frontdoor; inside the Worker, every JWT failure is a hard 403 so it is unambiguously a
   denial, not a "try again" signal (spec §9's fail-closed requirement).
3. **Auth is fail-closed by construction** (S16 AC): missing header, malformed token,
   expired, wrong `aud`, unknown `kid`, JWKS fetch failure, JWKS cache corruption, or `KV`
   absent in prod — all 403 with a generic message; no success-path data is returned before
   verification; verify runs before any DB read on the admin surface (`/admin*`, `/api/*`).
4. **Robustness rules for the served surface** (spec §11, §15, risk R15): Worker-origin 404s
   are `Cache-Control: no-store` (never cache a miss); entry errors serve
   `public, max-age=300, stale-while-revalidate=3600` and **5xx entries are re-checked without
   caching** (`no-store`) so a transient render failure cannot be cached — the stale-on-error
   default keeps last-good content serving during D1/R2 blips (verified cache semantics:
   <https://developers.cloudflare.com/cache/concepts/revalidation/#controlling-stale-behavior>).
5. **413 payload guard** at ~95 MB (platform request-body limit 100 MB on Free/Pro —
   <https://developers.cloudflare.com/workers/platform/limits/>): exceeded → 413 before any
   R2/D1 work (S17 AC).
6. **Purge failures are non-fatal post-write**: the DB/R2 write succeeded; a purge error is
   logged (pino optional; console at v1) and the response still returns success — stale
   content self-heals via SWR. Documented in `docs/architecture/04`.

## Consequences

- Error contract is stable and testable: every slice's failure-mode tests assert `code` +
  `status` + shape (06 slice→module map).
- The fail-closed JWT matrix (ADR 0003) plus 403-only policy means the admin surface has one
  unambiguous denial path end-to-end.
- 5xx-never-cached protects the CDN from serving broken renders; stale-on-error protects
  readers during blips — both behaviors are operator-checklist items (06).
- `401` absence is intentional and documented; future contributors won't "fix" it.
