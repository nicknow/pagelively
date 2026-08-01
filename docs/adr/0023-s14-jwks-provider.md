# 0023: S14 — KV-backed JWKS provider

- Status: accepted
- Date: 2026-07-31

## Context

Slice S14 provides the key-lookup seam for the defense-in-depth Access JWT verification
implemented in S16. The provider must:

- Fetch the team's JWKS from the Cloudflare Access endpoint.
- Cache it in the optional KV namespace so S16 does not hit the remote endpoint on every
  admin/API request.
- Work when KV is absent, and degrade safely on cache miss, corruption, or write failure.

Two implementation decisions were needed: whether to use Web Crypto or `jose` for key import,
and how to handle the optional KV cache.

## Decision

1. **Web Crypto only for key import (no `jose` added).**
   - `jose` is already sanctioned by ADR 0002 for S16's verification step, but it is not currently
     a dependency in `package.json`. Adding it solely for the S14 key-import step would
     increase bundle size and dependency surface for a task that `crypto.subtle.importKey`
     handles directly.
   - The provider decodes the JWT header, looks up the matching JWK by `kid`, and imports it
     into a `CryptoKey` using the algorithm implied by the JWK (`kty` + `alg`).
   - This returns a `KeyLike` (`CryptoKey`) that S16 can pass to `jose` if it chooses, or use
     directly with Web Crypto. If S16 is implemented with `jose`, the dependency will be added
     then; if S16 uses Web Crypto, no extra dependency is needed.
   - Supported key types: RSA (`RS256/384/512`, `PS256/384/512`) and EC (`ES256/384/512`).
     Cloudflare Access currently uses RSA (RS256), but the mapping is robust enough for future
     key types.

2. **JWKS endpoint and URL construction.**
   - Cloudflare Access publishes JWKS at `https://{team-domain}/cdn-cgi/access/certs`
     (verified: <https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/application-token/>).
   - The provider receives `teamDomainUrl` from `config.ts`, which already stores the full
     `https://...` URL per OQ-12. The provider normalizes any trailing slash or duplicate scheme
     defensively and appends `/cdn-cgi/access/certs`.

3. **KV cache key, TTL, and graceful degradation.**
   - KV key: `access-jwks`.
   - TTL: `expirationTtl: 3600` (1 hour).
   - KV is optional; if `kv` is not provided, the provider fetches the JWKS every time.
   - On KV miss, stale expiry, or corrupt JSON (missing `keys` array or invalid JSON), the
     provider fetches fresh and overwrites KV.
   - KV write failures are logged and ignored; the fetched key is still returned so the request
     can proceed. This is safe because the worst case is the next request fetches again.
   - Fetch failures and unknown `kid`s return `undefined` so S16 can fail closed (403).

4. **JWT header decoding without verification.**
   - The provider only needs the unprotected `kid` from the JWT header. It parses the first
     base64url segment without a JWT library, converts it to standard base64, and extracts the
     `kid`. Malformed headers return `undefined` without touching the network.

5. **No in-memory JWKS cache.**
   - The provider checks KV on every call. The 1-hour KV TTL is the staleness bound. This avoids
     keeping stale keys across Worker invocations if KV is refreshed externally.

## Consequences

- S14 keeps the dependency surface minimal: `package.json` needs no changes for the provider.
- The returned `CryptoKey` is verified usable in tests by signing a JWT with a locally generated
  RSA keypair and verifying the signature with the imported key.
- S16 can consume the key through either Web Crypto or `jose` without changing the provider
  interface.
- KV is a pure performance/availability optimization: the app works without it, and every
  failure path (KV absent, corrupt, unwritable, fetch failure) degrades to a fresh fetch or
  `undefined` rather than throwing.

## Cross-references

- Spec: §2 (optional KV), §9 (Access JWT), §12 (ACCESS_TEAM_DOMAIN).
- Docs: `docs/development/roadmap.md` S14, `docs/architecture/02-module-boundaries-contracts.md`
  JWT seam.
- ADRs: 0002 (dependency policy), 0005 (auth fail-closed), 0009 (cache seam), 0022 (S13 cache).
- Code: `src/jwks-provider.ts`, `test/jwks-provider.test.ts`.
