import { vi } from "vitest";
import { createJwksProvider, type JwksProvider } from "../src/jwks-provider";

// Shared test helpers for JWT + JWKS scenarios (S14, S16).
// No real Cloudflare Access is used; all keys are generated locally in the
// Vitest Workers pool and served by a mock JWKS endpoint.

export const TEAM_DOMAIN = "testteam.cloudflareaccess.com";
export const TEAM_DOMAIN_URL = `https://${TEAM_DOMAIN}`;
export const ACCESS_AUD = "test-audience-tag";

export function base64UrlEncode(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(input: string): string {
  const padding = (4 - (input.length % 4)) % 4;
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padding);
  return atob(base64);
}

export type JwtAlg =
  "RS256" | "RS384" | "RS512" | "PS256" | "PS384" | "PS512" | "ES256" | "ES384" | "ES512";

export function hashForAlg(alg: JwtAlg): string {
  if (alg === "RS384" || alg === "PS384" || alg === "ES384") {
    return "SHA-384";
  }
  if (alg === "RS512" || alg === "PS512" || alg === "ES512") {
    return "SHA-512";
  }
  return "SHA-256";
}

export function saltLengthForHash(hash: string): number {
  if (hash === "SHA-384") {
    return 48;
  }
  if (hash === "SHA-512") {
    return 64;
  }
  return 32;
}

export function unsignedJwt(kid: string, alg: JwtAlg = "RS256"): string {
  const header = base64UrlEncode(JSON.stringify({ alg, kid }));
  const payload = base64UrlEncode(JSON.stringify({ sub: "test" }));
  return `${header}.${payload}.`;
}

export async function generateKeyPair(
  kid: string,
  alg: JwtAlg = "RS256",
): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: JsonWebKey;
}> {
  if (alg.startsWith("RS") || alg.startsWith("PS")) {
    const hash = hashForAlg(alg);
    const name = alg.startsWith("PS") ? "RSA-PSS" : "RSASSA-PKCS1-v1_5";
    const keyPair = (await crypto.subtle.generateKey(
      {
        name,
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash,
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & {
      kid?: string;
    };
    jwk.kid = kid;
    jwk.use = "sig";
    jwk.alg = alg;
    return { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey, jwk };
  }

  const namedCurve = alg === "ES384" ? "P-384" : alg === "ES512" ? "P-521" : "P-256";
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "ECDSA",
      namedCurve,
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & {
    kid?: string;
  };
  jwk.kid = kid;
  jwk.use = "sig";
  jwk.alg = alg;
  return { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey, jwk };
}

export async function signJwt(
  privateKey: CryptoKey,
  kid: string,
  payload: object,
  alg: JwtAlg = "RS256",
): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg, kid }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const data = new TextEncoder().encode(`${header}.${body}`);
  const hash = hashForAlg(alg);
  const keyName = privateKey.algorithm.name;
  const algorithm =
    keyName === "ECDSA"
      ? { name: "ECDSA", hash }
      : keyName === "RSA-PSS"
        ? { name: "RSA-PSS", hash, saltLength: saltLengthForHash(hash) }
        : { name: "RSASSA-PKCS1-v1_5" };
  const signature = await crypto.subtle.sign(algorithm, privateKey, data);
  const sig = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
  return `${header}.${body}.${sig}`;
}

export function createMockFetch(
  jwks: object,
  options: { fail?: boolean; status?: number } = {},
): {
  fetchFn: typeof fetch;
  calls: { url: string }[];
} {
  const calls: { url: string }[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url });
    if (options.fail) {
      throw new Error("network down");
    }
    const status = options.status ?? 200;
    const body = status === 200 ? JSON.stringify(jwks) : "";
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

export function createMockJwksProvider(
  jwks: { keys: JsonWebKey[] },
  options: { fail?: boolean; status?: number } = {},
): {
  provider: JwksProvider;
  fetchFn: typeof fetch;
  calls: { url: string }[];
} {
  const { fetchFn, calls } = createMockFetch(jwks, options);
  const provider = createJwksProvider({ teamDomainUrl: TEAM_DOMAIN_URL, fetchFn });
  return { provider, fetchFn, calls };
}
