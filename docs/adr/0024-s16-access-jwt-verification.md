# 0024: S16 — Access JWT verification (defense-in-depth gate)

- Status: accepted
- Date: 2026-07-31

## Context

Slice S16 wires the defense-in-depth JWT gate into the Worker for every `/admin*` and `/api/*`
request (spec §9). Cloudflare Access authenticates users at the edge and forwards a signed
`Cf-Access-Jwt-Assertion` header. The Worker independently verifies that token before exposing
any admin or API behavior.

The main decision was how to verify the JWT signature and claims:

1. **Use `jose` or Web Crypto?** Cloudflare's official example uses `jose` (`jwtVerify`,
   `createRemoteJWKSet`) with a single `TEAM_DOMAIN` environment variable
   (<https://developers.cloudflare.com/changelog/product/workers/5/>). The architecture ADR
   0002 originally listed `jose` as an allowed dependency, but it was not present in
   `package.json`. Adding it would increase bundle size and dependency surface for a task
   the Web Crypto API can perform directly, especially because S14 already imports the
   public key as a `CryptoKey`.
2. **Claims to verify.** Cloudflare Access application tokens carry `iss`, `aud`, `exp`,
   `iat`, and optionally `email` (verified payload examples:
   <https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/>).
   The Worker must check all of them and fail closed on any mismatch.
3. **Clock skew.** The Access docs and API Shield JWT validation allow up to 60 seconds of
   clock skew for `exp` and `nbf`/`iat`
   (<https://developers.cloudflare.com/api-shield/security/jwt-validation/api/>); S16 applies
   the same 60-second window to `exp` and `iat`.
4. **Fail-closed behavior.** A missing header, malformed token, invalid signature, expired
   token, wrong audience/issuer, unknown `kid`, or unset `aud` must all result in a 403
   (ADR 0005).

## Decision

1. **Web Crypto only, no `jose` dependency.**
   - The JwksProvider seam (S14 / ADR 0023) already returns a Web Crypto `CryptoKey` for the
     JWT's `kid`. We verify the signature directly with `crypto.subtle.verify` using the
     algorithm derived from the JWT header `alg` and the key's `algorithm.name`.
   - This keeps the bundle size unchanged (verified: `wrangler deploy --dry-run` reports
     ~36.5 KiB / gzip ~9.6 KiB after S16) and avoids adding a dependency that would
     otherwise be used only for this single function.
   - Supported algorithms mirror the provider seam: RSA (`RSASSA-PKCS1-v1_5` / `RSA-PSS`) and
     ECDSA (`ES256/384/512`). Cloudflare Access currently uses `RS256`, but the gate is
     robust to future key types.
   - For `RSA-PSS` the `saltLength` is inferred from the hash length (32/48/64 bytes). This is
     a conservative fallback; Access uses PKCS1-v1_5 in practice.

2. **Claims verified.**
   - `iss` is compared against the configured team domain. The config value is normalized to
     `https://{domain}` (OQ-12), and the issuer is accepted either with or without the
     `https://` prefix, but never with a different scheme (e.g., `http://` is rejected).
   - `aud` is compared against the configured `ACCESS_AUD`. The token `aud` may be a string or
     an array of strings (RFC 7519); the configured value must be present.
   - `exp` must be in the future (allowing +60 seconds skew).
   - `iat` must be in the past (allowing +60 seconds skew).
   - If `aud` is `null` or empty (placeholder/unset), the gate returns `null` immediately.
   - `email` is extracted from the payload if present and returned as `string | null` for the
     dashboard (spec §9).

3. **Interface and integration.**
   - `createAccessVerifier(deps)` returns an `AccessVerifier` with a single `verify(request)`
     method that resolves to `VerifiedIdentity | null`.
   - The verifier is created per request in `src/index.ts` and called before any `/admin*` or
     `/api/*` handler. A `null` result produces a 403 JSON response `{ error: "Forbidden" }` with
     `Cache-Control: no-store`.
   - Public routes (`/health`, `/`, `/{slug}/`, `/p/{id}/`) do not call the verifier.

4. **Error handling.**
   - `verify()` never throws. All failures are logged and converted to `null` so the caller can
     return a consistent 403 (ADR 0005).
   - Internal verification errors are logged via the optional `logError` dependency.

## Consequences

- No new runtime dependency; bundle size remains small and the dependency surface is
  unchanged.
- The JWT gate is testable locally with generated RSA/EC keypairs and a mock JWKS endpoint,
  covering the full fail-closed matrix required by S16.
- Future key types beyond the current `RS256` require only matching updates in the JwksProvider
  and the verifier's algorithm mapping; no third-party library upgrade is needed.
- The `iss` comparison is intentionally strict: only the configured team's domain (with or
  without `https://`) is accepted, preventing tokens from a different Access tenant from
  passing even if the signature is otherwise valid.
- `aud` is treated as mandatory: an unset or placeholder `ACCESS_AUD` causes every admin/API
  request to fail closed, which is the safe default for a freshly provisioned app.

## Supersedes

- **ADR 0002 decision 4** originally listed `jose` as a runtime dependency. This ADR
  supersedes that decision: the runtime dependency surface is now only `marked`; Access JWT
  verification is performed with the Web Crypto API. The `JwksProvider` seam (S14) and the
  `AccessVerifier` (S16) implement the necessary JWKS fetch, caching, and verification.

## Cross-references

- Spec: §9 (auth & security), §12 (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`).
- Docs: `docs/architecture/02-module-boundaries-contracts.md` JWT seam.
- ADRs: 0002 (dependency policy), 0005 (fail-closed), 0023 (JWKS provider).
- Code: `src/access-verify.ts`, `src/index.ts`, `test/access-verify.test.ts`,
  `test/admin-auth.test.ts`, `test/jwt-test-helpers.ts`.
