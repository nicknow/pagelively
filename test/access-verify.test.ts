import { describe, expect, it, vi } from "vitest";
import { createAccessVerifier, decodeJwtPayload } from "../src/access-verify";
import {
  ACCESS_AUD,
  base64UrlDecode,
  base64UrlEncode,
  createMockJwksProvider,
  generateKeyPair,
  signJwt,
  TEAM_DOMAIN,
  TEAM_DOMAIN_URL,
} from "./jwt-test-helpers";

// S16 — Access JWT verification defense-in-depth gate.
// Tests run locally with generated RSA keypairs and a mock JWKS endpoint.

function requestWithToken(token: string | null): Request {
  const headers =
    token === null ? new Headers() : new Headers({ "Cf-Access-Jwt-Assertion": token });
  return new Request("https://pages.example.com/admin", { headers });
}

function buildPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: TEAM_DOMAIN_URL,
    aud: [ACCESS_AUD],
    iat: now,
    exp: now + 3600,
    email: "test@example.com",
    ...overrides,
  };
}

describe("createAccessVerifier", () => {
  it("returns the verified identity for a valid RS256 token", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-1", buildPayload());
    const identity = await verifier.verify(requestWithToken(token));
    expect(identity).toEqual({ email: "test@example.com" });
  });

  it("returns the verified identity for a valid ES256 token", async () => {
    const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & {
      kid?: string;
    };
    jwk.kid = "ec-key-1";
    jwk.use = "sig";
    jwk.alg = "ES256";
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const header = base64UrlEncode(JSON.stringify({ alg: "ES256", kid: "ec-key-1" }));
    const body = base64UrlEncode(JSON.stringify(buildPayload()));
    const data = new TextEncoder().encode(`${header}.${body}`);
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      data,
    );
    const sig = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
    const token = `${header}.${body}.${sig}`;
    expect(await verifier.verify(requestWithToken(token))).toEqual({ email: "test@example.com" });
  });

  it("returns null when the Cf-Access-Jwt-Assertion header is missing", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const identity = await verifier.verify(requestWithToken(null));
    expect(identity).toBeNull();
  });

  it("returns null for a malformed JWT", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    expect(await verifier.verify(requestWithToken("not-a-jwt"))).toBeNull();
    expect(await verifier.verify(requestWithToken("header.payload"))).toBeNull();
    expect(await verifier.verify(requestWithToken(""))).toBeNull();
  });

  it("returns null for a tampered token", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-1", buildPayload());
    const [header, payload, signature] = token.split(".");
    const payloadObj = JSON.parse(base64UrlDecode(payload)) as { email: string };
    payloadObj.email = "attacker@example.com";
    const tamperedPayload = base64UrlEncode(JSON.stringify(payloadObj));
    const tampered = `${header}.${tamperedPayload}.${signature}`;
    expect(await verifier.verify(requestWithToken(tampered))).toBeNull();
  });

  it("returns null for a token with an unknown kid", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const { privateKey: unknownPrivateKey } = await generateKeyPair("unknown-key");
    const token = await signJwt(unknownPrivateKey, "unknown-key", buildPayload());
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns null when the JWKS provider cannot resolve the key", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] }, { fail: true });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-1", buildPayload());
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      privateKey,
      "key-1",
      buildPayload({ iat: now - 7200, exp: now - 3600 }),
    );
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns null for a token with a wrong audience", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-1", buildPayload({ aud: ["wrong-aud"] }));
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns null for a token with a wrong issuer", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(
      privateKey,
      "key-1",
      buildPayload({ iss: "https://evil.cloudflareaccess.com" }),
    );
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns null when the configured audience is null/empty", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: null,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-1", buildPayload());
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("accepts the issuer both as a bare domain and as an https:// URL", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const bareToken = await signJwt(privateKey, "key-1", buildPayload({ iss: TEAM_DOMAIN }));
    const httpsToken = await signJwt(privateKey, "key-1", buildPayload({ iss: TEAM_DOMAIN_URL }));
    expect(await verifier.verify(requestWithToken(bareToken))).toEqual({
      email: "test@example.com",
    });
    expect(await verifier.verify(requestWithToken(httpsToken))).toEqual({
      email: "test@example.com",
    });
  });

  it("rejects an issuer using http://", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(
      privateKey,
      "key-1",
      buildPayload({ iss: `http://${TEAM_DOMAIN}` }),
    );
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("accepts the audience as a string or a single-element array", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const stringToken = await signJwt(privateKey, "key-1", buildPayload({ aud: ACCESS_AUD }));
    const arrayToken = await signJwt(privateKey, "key-1", buildPayload({ aud: [ACCESS_AUD] }));
    expect(await verifier.verify(requestWithToken(stringToken))).toEqual({
      email: "test@example.com",
    });
    expect(await verifier.verify(requestWithToken(arrayToken))).toEqual({
      email: "test@example.com",
    });
  });

  it("returns null when the audience array does not contain the configured audience", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(
      privateKey,
      "key-1",
      buildPayload({ aud: ["other-aud", ACCESS_AUD + "x"] }),
    );
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns email null when the token payload omits the email claim", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-1", buildPayload({ email: undefined }));
    expect(await verifier.verify(requestWithToken(token))).toEqual({ email: null });
  });

  it("allows a token within the 60-second clock skew window for exp", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      privateKey,
      "key-1",
      buildPayload({ iat: now - 30, exp: now - 30 }),
    );
    expect(await verifier.verify(requestWithToken(token))).toEqual({ email: "test@example.com" });
  });

  it("rejects a token outside the 60-second clock skew window for exp", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      privateKey,
      "key-1",
      buildPayload({ iat: now - 90, exp: now - 90 }),
    );
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("allows a token within the 60-second clock skew window for iat", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      privateKey,
      "key-1",
      buildPayload({ iat: now + 30, exp: now + 3630 }),
    );
    expect(await verifier.verify(requestWithToken(token))).toEqual({ email: "test@example.com" });
  });

  it("rejects a token outside the 60-second clock skew window for iat", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      privateKey,
      "key-1",
      buildPayload({ iat: now + 90, exp: now + 3690 }),
    );
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("uses a custom clock skew value when provided", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
      clockSkew: 120,
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await signJwt(
      privateKey,
      "key-1",
      buildPayload({ iat: now + 90, exp: now + 3690 }),
    );
    expect(await verifier.verify(requestWithToken(token))).toEqual({ email: "test@example.com" });
  });

  it("returns null when the configured audience is an empty string", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: "",
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-1", buildPayload());
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns null when the configured team domain is empty", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: "",
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-1", buildPayload());
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns null and does not throw when the JWKS provider throws", async () => {
    const throwingProvider = {
      getKey: async () => {
        throw new Error("provider exploded");
      },
    };
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: throwingProvider,
    });
    const header = base64UrlEncode(JSON.stringify({ alg: "RS256", kid: "key-1" }));
    const token = `${header}.${base64UrlEncode("{}")}.sig`;
    await expect(verifier.verify(requestWithToken(token))).resolves.toBeNull();
  });

  it("returns null and does not throw when anything fails during verification", async () => {
    const { provider } = createMockJwksProvider({ keys: [] }, { fail: true });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    await expect(verifier.verify(requestWithToken("bad-token"))).resolves.toBeNull();
    await expect(verifier.verify(requestWithToken(null))).resolves.toBeNull();
  });

  it("returns null when the JWT payload is not an object", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const header = base64UrlEncode(JSON.stringify({ alg: "RS256", kid: "key-1" }));
    const body = base64UrlEncode(JSON.stringify(123));
    const data = new TextEncoder().encode(`${header}.${body}`);
    const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, data);
    const sig = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
    expect(await verifier.verify(requestWithToken(`${header}.${body}.${sig}`))).toBeNull();
  });

  it("returns null when the exp claim is missing", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const payload = buildPayload();
    const withoutExp = { ...payload };
    delete withoutExp.exp;
    const token = await signJwt(privateKey, "key-1", withoutExp);
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns null when the exp claim is not a number", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-1", buildPayload({ exp: "future" }));
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns null when the iat claim is missing", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const payload = buildPayload();
    const withoutIat = { ...payload };
    delete withoutIat.iat;
    const token = await signJwt(privateKey, "key-1", withoutIat);
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns null when the iat claim is not a number", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-1", buildPayload({ iat: "recent" }));
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns null when the aud claim is neither a string nor an array", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-1", buildPayload({ aud: 12345 }));
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns null when the JWT header is missing the alg claim", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const header = base64UrlEncode(JSON.stringify({ kid: "key-1" }));
    const body = base64UrlEncode(JSON.stringify(buildPayload()));
    const data = new TextEncoder().encode(`${header}.${body}`);
    const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, data);
    const sig = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
    expect(await verifier.verify(requestWithToken(`${header}.${body}.${sig}`))).toBeNull();
  });

  it("returns null when the JWT header is not an object", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const header = base64UrlEncode(JSON.stringify(["alg", "RS256"]));
    const body = base64UrlEncode(JSON.stringify(buildPayload()));
    const data = new TextEncoder().encode(`${header}.${body}`);
    const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, data);
    const sig = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
    expect(await verifier.verify(requestWithToken(`${header}.${body}.${sig}`))).toBeNull();
  });

  it("returns null when the JWT header kid is not a string", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const header = base64UrlEncode(JSON.stringify({ alg: "RS256", kid: 123 }));
    const body = base64UrlEncode(JSON.stringify(buildPayload()));
    const data = new TextEncoder().encode(`${header}.${body}`);
    const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, data);
    const sig = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
    expect(await verifier.verify(requestWithToken(`${header}.${body}.${sig}`))).toBeNull();
  });

  it("returns null when the resolved key has an unsupported algorithm", async () => {
    const hmacKey = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    const provider = { getKey: async () => hmacKey as unknown as CryptoKey };
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const header = base64UrlEncode(JSON.stringify({ alg: "RS256", kid: "key-1" }));
    const token = `${header}.${base64UrlEncode("{}")}.sig`;
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns null when the issuer claim is not a string", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-1", buildPayload({ iss: 12345 }));
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns null when crypto.subtle.verify throws on a malformed signature", async () => {
    const { jwk } = await generateKeyPair("ec-key", "ES256");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const header = base64UrlEncode(JSON.stringify({ alg: "ES256", kid: "ec-key" }));
    const body = base64UrlEncode(JSON.stringify(buildPayload()));
    // A valid ECDSA P-256 signature is much longer than 4 bytes.
    const token = `${header}.${body}.${base64UrlEncode("abcd")}`;
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
  });

  it("returns null when crypto.subtle.verify throws unexpectedly", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-1", buildPayload());
    const spy = vi
      .spyOn(crypto.subtle, "verify")
      .mockRejectedValueOnce(new Error("verify blew up"));
    expect(await verifier.verify(requestWithToken(token))).toBeNull();
    spy.mockRestore();
  });

  it("returns null when crypto.subtle.verify throws due to signature/key mismatch", async () => {
    // Sign an RS256 token with an RSA key, then have the JWKS provider return an
    // ECDSA key for the same kid. The verifier derives an ECDSA algorithm from the
    // key, and Web Crypto rejects the RSA signature bytes.
    const { privateKey: rsaPrivateKey } = await generateKeyPair("mixed-key", "RS256");
    const { jwk: ecJwk } = await generateKeyPair("mixed-key", "ES256");
    const { provider } = createMockJwksProvider({ keys: [ecJwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const header = base64UrlEncode(JSON.stringify({ alg: "RS256", kid: "mixed-key" }));
    const body = base64UrlEncode(JSON.stringify(buildPayload()));
    const data = new TextEncoder().encode(`${header}.${body}`);
    const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, rsaPrivateKey, data);
    const sig = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
    expect(await verifier.verify(requestWithToken(`${header}.${body}.${sig}`))).toBeNull();
  });

  it("returns null when the JWT payload segment is malformed JSON", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const header = base64UrlEncode(JSON.stringify({ alg: "RS256", kid: "key-1" }));
    const body = base64UrlEncode("not json");
    const data = new TextEncoder().encode(`${header}.${body}`);
    const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, data);
    const sig = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
    expect(await verifier.verify(requestWithToken(`${header}.${body}.${sig}`))).toBeNull();
  });

  it("returns null when the JWT header segment is malformed base64url", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const body = base64UrlEncode(JSON.stringify(buildPayload()));
    const data = new TextEncoder().encode(`!!!.${body}`);
    const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, data);
    const sig = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
    expect(await verifier.verify(requestWithToken(`!!!.${body}.${sig}`))).toBeNull();
  });

  it("accepts the team domain configured with a trailing slash", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: `${TEAM_DOMAIN_URL}/`,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-1", buildPayload({ iss: TEAM_DOMAIN_URL }));
    expect(await verifier.verify(requestWithToken(token))).toEqual({ email: "test@example.com" });
  });

  it("accepts the issuer with a trailing slash", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-1", buildPayload({ iss: `${TEAM_DOMAIN_URL}/` }));
    expect(await verifier.verify(requestWithToken(token))).toEqual({ email: "test@example.com" });
  });

  it("verifies a valid RS384 token", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-384", "RS384");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-384", buildPayload(), "RS384");
    expect(await verifier.verify(requestWithToken(token))).toEqual({ email: "test@example.com" });
  });

  it("verifies a valid RS512 token", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-512", "RS512");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "key-512", buildPayload(), "RS512");
    expect(await verifier.verify(requestWithToken(token))).toEqual({ email: "test@example.com" });
  });

  it("verifies a valid ES384 token", async () => {
    const { privateKey, jwk } = await generateKeyPair("ec-key-384", "ES384");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "ec-key-384", buildPayload(), "ES384");
    expect(await verifier.verify(requestWithToken(token))).toEqual({ email: "test@example.com" });
  });

  it("verifies a valid ES512 token", async () => {
    const { privateKey, jwk } = await generateKeyPair("ec-key-512", "ES512");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "ec-key-512", buildPayload(), "ES512");
    expect(await verifier.verify(requestWithToken(token))).toEqual({ email: "test@example.com" });
  });

  it("verifies a valid PS256 token", async () => {
    const { privateKey, jwk } = await generateKeyPair("pss-key-256", "PS256");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "pss-key-256", buildPayload(), "PS256");
    expect(await verifier.verify(requestWithToken(token))).toEqual({ email: "test@example.com" });
  });

  it("verifies a valid PS384 token", async () => {
    const { privateKey, jwk } = await generateKeyPair("pss-key-384", "PS384");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "pss-key-384", buildPayload(), "PS384");
    expect(await verifier.verify(requestWithToken(token))).toEqual({ email: "test@example.com" });
  });

  it("verifies a valid PS512 token", async () => {
    const { privateKey, jwk } = await generateKeyPair("pss-key-512", "PS512");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
    });
    const token = await signJwt(privateKey, "pss-key-512", buildPayload(), "PS512");
    expect(await verifier.verify(requestWithToken(token))).toEqual({ email: "test@example.com" });
  });

  it("uses a zero-second clock skew to accept exactly-now tokens and reject clearly stale ones", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { provider } = createMockJwksProvider({ keys: [jwk] });
    const verifier = createAccessVerifier({
      teamDomainUrl: TEAM_DOMAIN_URL,
      aud: ACCESS_AUD,
      jwksProvider: provider,
      clockSkew: 0,
    });
    const now = Math.floor(Date.now() / 1000);
    const validToken = await signJwt(
      privateKey,
      "key-1",
      buildPayload({ iat: now - 10, exp: now + 10 }),
    );
    const expiredToken = await signJwt(
      privateKey,
      "key-1",
      buildPayload({ iat: now - 20, exp: now - 10 }),
    );
    const futureToken = await signJwt(
      privateKey,
      "key-1",
      buildPayload({ iat: now + 10, exp: now + 20 }),
    );
    expect(await verifier.verify(requestWithToken(validToken))).toEqual({
      email: "test@example.com",
    });
    expect(await verifier.verify(requestWithToken(expiredToken))).toBeNull();
    expect(await verifier.verify(requestWithToken(futureToken))).toBeNull();
  });
});

describe("decodeJwtPayload", () => {
  it("returns the parsed payload for a valid JWT", () => {
    const payload = { sub: "user", aud: ["app"] };
    const header = base64UrlEncode(JSON.stringify({ alg: "RS256", kid: "key-1" }));
    const body = base64UrlEncode(JSON.stringify(payload));
    const token = `${header}.${body}.signature`;
    expect(decodeJwtPayload(token)).toEqual(payload);
  });

  it("returns undefined for a JWT without three segments", () => {
    expect(decodeJwtPayload("")).toBeUndefined();
    expect(decodeJwtPayload("header")).toBeUndefined();
    expect(decodeJwtPayload("header.payload")).toBeUndefined();
    expect(decodeJwtPayload("header.payload.signature.extra")).toBeUndefined();
  });

  it("returns undefined when the payload segment is not valid base64url", () => {
    const token = `header.!!!.signature`;
    expect(decodeJwtPayload(token)).toBeUndefined();
  });

  it("returns undefined when the payload segment is not valid JSON", () => {
    const header = base64UrlEncode(JSON.stringify({ alg: "RS256", kid: "key-1" }));
    const body = base64UrlEncode("not json");
    const token = `${header}.${body}.signature`;
    expect(decodeJwtPayload(token)).toBeUndefined();
  });
});
