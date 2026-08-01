/**
 * S14 — KV-backed JWKS provider for Cloudflare Access JWT verification.
 *
 * This module only *looks up* the public key matching the JWT `kid` (S16 does the actual
 * signature verification). The provider:
 *
 * - Reads the JWT header without verifying it to extract the `kid`.
 * - Fetches the team JWKS from `https://{teamDomain}/cdn-cgi/access/certs` and caches it
 *   in the optional KV namespace under `access-jwks` with a 1-hour TTL.
 * - Gracefully degrades when KV is absent, corrupt, or unwritable; fetch failures and
 *   unknown kids return `undefined` so the caller (S16) can fail closed.
 * - Imports the matching JWK into a Web Crypto `CryptoKey` so it can be used by either
 *   Web Crypto or a small library later.
 *
 * Spec refs: §2 (optional KV), §9 (Access JWT + JWKS URL), §12 (ACCESS_TEAM_DOMAIN).
 * Architecture: `docs/architecture/02-module-boundaries-contracts.md` JWT seam.
 */

export interface JwksProvider {
  /** Look up the public key for the given JWT's `kid`. Returns `undefined` on miss/error. */
  getKey(jwt: string): Promise<CryptoKey | undefined>;
}

export interface JwksProviderOptions {
  /** Zero Trust team domain URL, e.g. `https://yourteam.cloudflareaccess.com`. */
  teamDomainUrl: string;
  /** Optional KV namespace for JWKS caching. If absent, every call fetches remotely. */
  kv?: KVNamespace;
  /** Fetch hook; defaults to the global `fetch`. Used by tests to mock the JWKS endpoint. */
  fetchFn?: typeof fetch;
  /** Error logger; defaults to `console.error`. */
  logError?: typeof console.error;
}

interface Jwks {
  keys: JsonWebKey[];
}

const JWKS_CACHE_KEY = "access-jwks";
const JWKS_CACHE_TTL = 3600; // 1 hour

/**
 * Build the Cloudflare Access JWKS endpoint.
 * The input may already include `https://` and a trailing slash; normalize both.
 * Verified URL: `https://{team-domain}/cdn-cgi/access/certs`
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/application-token/
 */
function jwksUrl(teamDomainUrl: string): string {
  const bare = teamDomainUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${bare}/cdn-cgi/access/certs`;
}

/** Decode a JWT header without verifying the signature. */
function decodeJwtHeader(jwt: string): { kid?: string } | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const headerB64 = parts[0].replace(/-/g, "+").replace(/_/g, "/");
    const padding = (4 - (headerB64.length % 4)) % 4;
    const headerJson = atob(headerB64 + "=".repeat(padding));
    const header = JSON.parse(headerJson) as unknown;
    if (
      header !== null &&
      typeof header === "object" &&
      !Array.isArray(header) &&
      "kid" in header &&
      typeof (header as { kid: unknown }).kid === "string"
    ) {
      return header as { kid?: string };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Return the import algorithm for a JWK, or `undefined` if unsupported. */
function algorithmFromJwk(jwk: JsonWebKey): SubtleCryptoImportKeyAlgorithm | undefined {
  if (jwk.kty === "RSA") {
    const hash =
      jwk.alg === "RS384" || jwk.alg === "PS384"
        ? "SHA-384"
        : jwk.alg === "RS512" || jwk.alg === "PS512"
          ? "SHA-512"
          : "SHA-256";
    if (jwk.alg?.startsWith("PS")) {
      return { name: "RSA-PSS", hash };
    }
    return { name: "RSASSA-PKCS1-v1_5", hash };
  }

  if (jwk.kty === "EC") {
    const namedCurve = jwk.crv ?? "P-256";
    const hash = jwk.alg === "ES384" ? "SHA-384" : jwk.alg === "ES512" ? "SHA-512" : "SHA-256";
    return { name: "ECDSA", namedCurve, hash };
  }

  return undefined;
}

function isJwks(value: unknown): value is Jwks {
  return (
    value !== null &&
    typeof value === "object" &&
    "keys" in value &&
    Array.isArray((value as Jwks).keys)
  );
}

async function fetchJwks(fetchFn: typeof fetch, teamDomainUrl: string): Promise<Jwks | undefined> {
  try {
    const response = await fetchFn(jwksUrl(teamDomainUrl));
    if (!response.ok) {
      return undefined;
    }
    const body = await response.text();
    const parsed = JSON.parse(body) as unknown;
    if (isJwks(parsed)) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function readCachedJwks(kv: KVNamespace): Promise<Jwks | undefined> {
  try {
    const cached = await kv.get(JWKS_CACHE_KEY);
    if (!cached) {
      return undefined;
    }
    const parsed = JSON.parse(cached) as unknown;
    if (isJwks(parsed)) {
      return parsed;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function writeCachedJwks(
  kv: KVNamespace,
  jwks: Jwks,
  logError: typeof console.error,
): Promise<void> {
  try {
    await kv.put(JWKS_CACHE_KEY, JSON.stringify(jwks), { expirationTtl: JWKS_CACHE_TTL });
  } catch (error) {
    logError("[jwks] cache write failed: %o", error);
  }
}

export function createJwksProvider(options: JwksProviderOptions): JwksProvider {
  const { teamDomainUrl, kv, fetchFn = fetch, logError = console.error } = options;

  async function resolveJwks(): Promise<Jwks | undefined> {
    if (kv) {
      const cached = await readCachedJwks(kv);
      if (cached) {
        return cached;
      }
    }

    const fresh = await fetchJwks(fetchFn, teamDomainUrl);
    if (fresh && kv) {
      await writeCachedJwks(kv, fresh, logError);
    }
    return fresh;
  }

  return {
    async getKey(jwt) {
      const header = decodeJwtHeader(jwt);
      if (!header?.kid) {
        return undefined;
      }

      const jwks = await resolveJwks();
      if (!jwks) {
        return undefined;
      }

      const jwk = jwks.keys.find((k) => (k as JsonWebKey & { kid?: string }).kid === header.kid);
      if (!jwk) {
        return undefined;
      }

      const algorithm = algorithmFromJwk(jwk);
      if (!algorithm) {
        return undefined;
      }

      try {
        return await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
      } catch {
        return undefined;
      }
    },
  };
}
