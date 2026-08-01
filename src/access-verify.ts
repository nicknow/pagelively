import type { JwksProvider } from "./jwks-provider";

/**
 * S16 — Access JWT verification defense-in-depth gate.
 *
 * The verifier runs on every `/admin*` and `/api/*` request. It extracts the
 * `Cf-Access-Jwt-Assertion` header, validates the signature against the team JWKS
 * via the JwksProvider seam, and checks the claims Cloudflare Access issues:
 * `iss`, `aud`, `exp`, and `iat`. Any failure returns `null` so the caller can
 * fail closed with a 403.
 *
 * Web Crypto is used directly for signature verification; no `jose` dependency is
 * added (ADR 0024). The key types supported mirror the JwksProvider seam: RSA
 * (RSASSA-PKCS1-v1_5 / RSA-PSS) and ECDSA.
 *
 * Spec refs: §9 (Cloudflare Access, fail-closed), §12 (ACCESS_TEAM_DOMAIN,
 * ACCESS_AUD).
 * Architecture: `docs/architecture/02-module-boundaries-contracts.md` JWT seam.
 */

export interface VerifiedIdentity {
  email: string | null;
}

export interface AccessVerifier {
  /** Verify the Access JWT on the request. Returns `null` for any failure. */
  verify(request: Request): Promise<VerifiedIdentity | null>;
}

export interface AccessVerifierOptions {
  /** Zero Trust team domain URL, e.g. `https://yourteam.cloudflareaccess.com`. */
  teamDomainUrl: string;
  /** Access application AUD tag. `null` or empty forces fail-closed. */
  aud: string | null;
  /** Key provider that returns a Web Crypto `CryptoKey` for the JWT `kid`. */
  jwksProvider: JwksProvider;
  /** Optional error logger; defaults to `console.error`. */
  logError?: typeof console.error;
  /** Optional clock skew in seconds for `exp`/`iat` checks; defaults to 60. */
  clockSkew?: number;
}

const DEFAULT_CLOCK_SKEW = 60;

function base64UrlDecode(input: string): string {
  const padding = (4 - (input.length % 4)) % 4;
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padding);
  return atob(base64);
}

function base64UrlToUint8Array(input: string): Uint8Array {
  const padding = (4 - (input.length % 4)) % 4;
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padding);
  const binary = atob(base64);
  return new Uint8Array([...binary].map((c) => c.charCodeAt(0)));
}

function decodeJwtHeader(jwt: string): { kid?: string; alg?: string } | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const headerJson = base64UrlDecode(parts[0]);
    const header = JSON.parse(headerJson) as unknown;
    if (header === null || typeof header !== "object" || Array.isArray(header)) {
      return undefined;
    }
    const kid = "kid" in header ? (header as { kid?: unknown }).kid : undefined;
    const alg = "alg" in header ? (header as { alg?: unknown }).alg : undefined;
    return {
      kid: typeof kid === "string" ? kid : undefined,
      alg: typeof alg === "string" ? alg : undefined,
    };
  } catch {
    return undefined;
  }
}

function decodeJwtPayload(jwt: string): unknown | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    return undefined;
  }
  try {
    const payloadJson = base64UrlDecode(parts[1]);
    return JSON.parse(payloadJson) as unknown;
  } catch {
    return undefined;
  }
}

function hashFromAlg(alg: string): string {
  if (alg === "RS384" || alg === "PS384" || alg === "ES384") {
    return "SHA-384";
  }
  if (alg === "RS512" || alg === "PS512" || alg === "ES512") {
    return "SHA-512";
  }
  return "SHA-256";
}

function saltLengthFromHash(hash: string): number {
  if (hash === "SHA-384") {
    return 48;
  }
  if (hash === "SHA-512") {
    return 64;
  }
  return 32;
}

function verifyAlgorithmForKey(key: CryptoKey, alg: string): SubtleCryptoSignAlgorithm {
  const hash = hashFromAlg(alg);
  const name = key.algorithm.name;
  if (name === "RSASSA-PKCS1-v1_5") {
    return { name: "RSASSA-PKCS1-v1_5", hash };
  }
  if (name === "RSA-PSS") {
    return { name: "RSA-PSS", hash, saltLength: saltLengthFromHash(hash) };
  }
  if (name === "ECDSA") {
    return { name: "ECDSA", hash };
  }
  throw new Error(`unsupported key algorithm: ${name}`);
}

async function verifyJwtSignature(jwt: string, key: CryptoKey): Promise<boolean> {
  const header = decodeJwtHeader(jwt);
  if (!header?.alg) {
    return false;
  }
  const parts = jwt.split(".");
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64UrlToUint8Array(parts[2]);
  const algorithm = verifyAlgorithmForKey(key, header.alg);
  try {
    return await crypto.subtle.verify(algorithm, key, signature, data);
  } catch {
    return false;
  }
}

function normalizeIssuer(input: string): string {
  return input.replace(/^https:\/\//, "").replace(/\/+$/, "");
}

function isIssuerValid(iss: unknown, teamDomainUrl: string): boolean {
  if (typeof iss !== "string") {
    return false;
  }
  return normalizeIssuer(iss) === normalizeIssuer(teamDomainUrl);
}

function isAudienceValid(payloadAud: unknown, expectedAud: string): boolean {
  if (typeof payloadAud === "string") {
    return payloadAud === expectedAud;
  }
  if (Array.isArray(payloadAud)) {
    return payloadAud.some((value) => value === expectedAud);
  }
  return false;
}

function getPayloadNumber(payload: object, key: string): number | undefined {
  if (key in payload && typeof (payload as Record<string, unknown>)[key] === "number") {
    return (payload as Record<string, unknown>)[key] as number;
  }
  return undefined;
}

export function createAccessVerifier(options: AccessVerifierOptions): AccessVerifier {
  const {
    teamDomainUrl,
    aud,
    jwksProvider,
    logError = console.error,
    clockSkew = DEFAULT_CLOCK_SKEW,
  } = options;

  async function verifyInternal(request: Request): Promise<VerifiedIdentity | null> {
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) {
      return null;
    }

    if (!aud || aud === "") {
      return null;
    }

    if (teamDomainUrl === "") {
      return null;
    }

    const header = decodeJwtHeader(token);
    if (!header?.kid) {
      return null;
    }

    const key = await jwksProvider.getKey(token);
    if (!key) {
      return null;
    }

    const signatureValid = await verifyJwtSignature(token, key);
    if (!signatureValid) {
      return null;
    }

    const payload = decodeJwtPayload(token);
    if (payload === undefined || payload === null || typeof payload !== "object") {
      return null;
    }

    const iss = (payload as Record<string, unknown>).iss;
    if (!isIssuerValid(iss, teamDomainUrl)) {
      return null;
    }

    const payloadAud = (payload as Record<string, unknown>).aud;
    if (!isAudienceValid(payloadAud, aud)) {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    const exp = getPayloadNumber(payload, "exp");
    if (exp === undefined || now > exp + clockSkew) {
      return null;
    }

    const iat = getPayloadNumber(payload, "iat");
    if (iat === undefined || now < iat - clockSkew) {
      return null;
    }

    const email = (payload as Record<string, unknown>).email;
    return { email: typeof email === "string" ? email : null };
  }

  return {
    async verify(request) {
      try {
        return await verifyInternal(request);
      } catch (error) {
        logError("[access-verify] verification failed: %o", error);
        return null;
      }
    },
  };
}
