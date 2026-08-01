import { describe, expect, it, vi } from "vitest";
import {
  createJwksProvider,
  type JwksProvider,
  type JwksProviderOptions,
} from "../src/jwks-provider";

// S14 — KV-backed JWKS provider: key lookup by `kid` for later Access JWT verification.
// Tests run against the local Vitest Workers pool with locally generated RSA keypairs
// and a mock JWKS endpoint (no real Cloudflare Access needed).

const JWKS_CACHE_KEY = "access-jwks";
const JWKS_CACHE_TTL = 3600;
const TEAM_DOMAIN = "testteam.cloudflareaccess.com";
const TEAM_DOMAIN_URL = `https://${TEAM_DOMAIN}`;

function base64UrlEncode(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(input: string): string {
  const padding = (4 - (input.length % 4)) % 4;
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(padding);
  return atob(base64);
}

function unsignedJwt(kid: string): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", kid }));
  const payload = base64UrlEncode(JSON.stringify({ sub: "test" }));
  return `${header}.${payload}.`;
}

async function generateKeyPair(kid: string): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  jwk: JsonWebKey;
}> {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & {
    kid?: string;
  };
  jwk.kid = kid;
  jwk.use = "sig";
  jwk.alg = "RS256";
  return { privateKey: keyPair.privateKey, publicKey: keyPair.publicKey, jwk };
}

async function signJwt(privateKey: CryptoKey, kid: string, payload: object): Promise<string> {
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", kid }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const data = new TextEncoder().encode(`${header}.${body}`);
  const signature = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, privateKey, data);
  const sig = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
  return `${header}.${body}.${sig}`;
}

class FakeKV {
  private store = new Map<string, string>();
  failPut = false;

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string, options?: KVNamespacePutOptions): Promise<void> {
    if (this.failPut) {
      throw new Error("KV write failed");
    }
    this.store.set(key, value);
    void options;
  }

  // Stubs for the rest of the KVNamespace interface — not exercised by the provider.
  async getWithMetadata(): Promise<KVNamespaceGetWithMetadataResult<string, unknown>> {
    return { value: null, metadata: null, cacheStatus: null };
  }

  async list(): Promise<KVNamespaceListResult<unknown, string>> {
    return {
      keys: [],
      list_complete: true,
      cursor: "",
      cacheStatus: null,
    } as unknown as KVNamespaceListResult<unknown, string>;
  }

  async delete(): Promise<void> {}
}

function asKvNamespace(kv: FakeKV): KVNamespace {
  return kv as unknown as KVNamespace;
}

function createMockFetch(
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

function createProvider(
  jwks: { keys: JsonWebKey[] },
  options: Partial<Omit<JwksProviderOptions, "kv" | "fetchFn">> = {},
): {
  provider: JwksProvider;
  kv: FakeKV;
  fetchFn: typeof fetch;
  calls: { url: string }[];
} {
  const kv = new FakeKV();
  const { fetchFn, calls } = createMockFetch(jwks);
  const provider = createJwksProvider({
    teamDomainUrl: TEAM_DOMAIN_URL,
    kv: asKvNamespace(kv),
    fetchFn,
    ...options,
  });
  return { provider, kv, fetchFn, calls };
}

describe("createJwksProvider", () => {
  it("builds the Cloudflare Access JWKS URL from the team domain", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const { provider, calls } = createProvider({ keys: [jwk] });
    await provider.getKey(unsignedJwt("key-1"));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${TEAM_DOMAIN_URL}/cdn-cgi/access/certs`);
  });

  it("normalizes a bare team domain into the Access JWKS URL", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const { fetchFn, calls } = createMockFetch({ keys: [jwk] });
    const provider = createJwksProvider({
      teamDomainUrl: TEAM_DOMAIN,
      fetchFn,
    });
    await provider.getKey(unsignedJwt("key-1"));
    expect(calls[0].url).toBe(`${TEAM_DOMAIN_URL}/cdn-cgi/access/certs`);
  });

  it("fetches the JWKS on first call and returns the matching key", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const { provider, kv, fetchFn, calls } = createProvider({ keys: [jwk] });
    const key = await provider.getKey(unsignedJwt("key-1"));
    expect(key).toBeDefined();
    expect(key!.type).toBe("public");
    expect(key!.algorithm.name).toBe("RSASSA-PKCS1-v1_5");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const cached = await kv.get(JWKS_CACHE_KEY);
    expect(cached).toBeTruthy();
    expect(JSON.parse(cached!)).toEqual({ keys: [jwk] });
    expect(calls).toHaveLength(1);
  });

  it("caches the JWKS with the agreed TTL", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const kv = new FakeKV();
    const putSpy = vi.spyOn(kv, "put");
    const { fetchFn } = createMockFetch({ keys: [jwk] });
    const provider = createJwksProvider({
      teamDomainUrl: TEAM_DOMAIN_URL,
      kv: asKvNamespace(kv),
      fetchFn,
    });
    await provider.getKey(unsignedJwt("key-1"));
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(putSpy).toHaveBeenCalledWith(JWKS_CACHE_KEY, JSON.stringify({ keys: [jwk] }), {
      expirationTtl: JWKS_CACHE_TTL,
    });
  });

  it("serves the second call from KV without a remote fetch", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const { provider, kv, fetchFn, calls } = createProvider({ keys: [jwk] });
    await provider.getKey(unsignedJwt("key-1"));
    const key = await provider.getKey(unsignedJwt("key-1"));
    expect(key).toBeDefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
    const cached = await kv.get(JWKS_CACHE_KEY);
    expect(JSON.parse(cached!)).toEqual({ keys: [jwk] });
  });

  it("fetches fresh when KV is empty", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const kv = new FakeKV();
    const { fetchFn, calls } = createMockFetch({ keys: [jwk] });
    const provider = createJwksProvider({
      teamDomainUrl: TEAM_DOMAIN_URL,
      kv: asKvNamespace(kv),
      fetchFn,
    });
    const key = await provider.getKey(unsignedJwt("key-1"));
    expect(key).toBeDefined();
    expect(calls).toHaveLength(1);
    expect(await kv.get(JWKS_CACHE_KEY)).toBeTruthy();
  });

  it("fetches fresh and overwrites KV when the cached JSON is corrupt", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const kv = new FakeKV();
    await kv.put(JWKS_CACHE_KEY, "not-json", { expirationTtl: JWKS_CACHE_TTL });
    const { fetchFn, calls } = createMockFetch({ keys: [jwk] });
    const provider = createJwksProvider({
      teamDomainUrl: TEAM_DOMAIN_URL,
      kv: asKvNamespace(kv),
      fetchFn,
    });
    const key = await provider.getKey(unsignedJwt("key-1"));
    expect(key).toBeDefined();
    expect(calls).toHaveLength(1);
    const cached = await kv.get(JWKS_CACHE_KEY);
    expect(JSON.parse(cached!)).toEqual({ keys: [jwk] });
  });

  it("fetches fresh and overwrites KV when the cached JWKS has no keys", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const kv = new FakeKV();
    await kv.put(JWKS_CACHE_KEY, JSON.stringify({}), { expirationTtl: JWKS_CACHE_TTL });
    const { fetchFn, calls } = createMockFetch({ keys: [jwk] });
    const provider = createJwksProvider({
      teamDomainUrl: TEAM_DOMAIN_URL,
      kv: asKvNamespace(kv),
      fetchFn,
    });
    const key = await provider.getKey(unsignedJwt("key-1"));
    expect(key).toBeDefined();
    expect(calls).toHaveLength(1);
    const cached = await kv.get(JWKS_CACHE_KEY);
    expect(JSON.parse(cached!)).toEqual({ keys: [jwk] });
  });

  it("returns undefined when no key matches the JWT kid", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const { provider } = createProvider({ keys: [jwk] });
    const key = await provider.getKey(unsignedJwt("unknown-kid"));
    expect(key).toBeUndefined();
  });

  it("works without a KV binding by fetching every time", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const { fetchFn, calls } = createMockFetch({ keys: [jwk] });
    const provider = createJwksProvider({ teamDomainUrl: TEAM_DOMAIN_URL, fetchFn });
    const first = await provider.getKey(unsignedJwt("key-1"));
    const second = await provider.getKey(unsignedJwt("key-1"));
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(calls).toHaveLength(2);
  });

  it("ignores KV write failures and still returns the fetched key", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const kv = new FakeKV();
    kv.failPut = true;
    const logErrors: unknown[][] = [];
    const { fetchFn } = createMockFetch({ keys: [jwk] });
    const provider = createJwksProvider({
      teamDomainUrl: TEAM_DOMAIN_URL,
      kv: asKvNamespace(kv),
      fetchFn,
      logError: (...args: unknown[]) => logErrors.push(args),
    });
    const key = await provider.getKey(unsignedJwt("key-1"));
    expect(key).toBeDefined();
    expect(logErrors.length).toBeGreaterThan(0);
    expect(await kv.get(JWKS_CACHE_KEY)).toBeNull();
  });

  it("returns undefined when the JWKS fetch fails", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const { fetchFn, calls } = createMockFetch({ keys: [jwk] }, { fail: true });
    const provider = createJwksProvider({ teamDomainUrl: TEAM_DOMAIN_URL, fetchFn });
    const key = await provider.getKey(unsignedJwt("key-1"));
    expect(key).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("returns undefined for a malformed JWT header", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const { fetchFn } = createMockFetch({ keys: [jwk] });
    const provider = createJwksProvider({ teamDomainUrl: TEAM_DOMAIN_URL, fetchFn });
    expect(await provider.getKey("not-a-jwt")).toBeUndefined();
    expect(await provider.getKey("header.payload")).toBeUndefined();
    expect(await provider.getKey("")).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns undefined when the fetched JWKS has no keys", async () => {
    const { fetchFn } = createMockFetch({ keys: [] });
    const provider = createJwksProvider({ teamDomainUrl: TEAM_DOMAIN_URL, fetchFn });
    const key = await provider.getKey(unsignedJwt("key-1"));
    expect(key).toBeUndefined();
  });

  it("imports a key that can verify a real JWT signature", async () => {
    const { privateKey, jwk } = await generateKeyPair("key-1");
    const { fetchFn } = createMockFetch({ keys: [jwk] });
    const provider = createJwksProvider({ teamDomainUrl: TEAM_DOMAIN_URL, fetchFn });
    const jwt = await signJwt(privateKey, "key-1", { sub: "test-user" });
    const key = await provider.getKey(jwt);
    expect(key).toBeDefined();

    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = new Uint8Array([...base64UrlDecode(sigB64)].map((c) => c.charCodeAt(0)));
    const valid = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      key!,
      signature.buffer,
      data,
    );
    expect(valid).toBe(true);
  });

  it("returns undefined when the imported JWK is not a supported key type", async () => {
    const { provider } = createProvider({
      keys: [{ kid: "oct-1", kty: "oct", k: "deadbeef" } as JsonWebKey],
    });
    const key = await provider.getKey(unsignedJwt("oct-1"));
    expect(key).toBeUndefined();
  });

  it("returns undefined when the fetched JWKS body is not a valid JWKS object", async () => {
    const { fetchFn } = createMockFetch({ notKeys: [] });
    const provider = createJwksProvider({ teamDomainUrl: TEAM_DOMAIN_URL, fetchFn });
    const key = await provider.getKey(unsignedJwt("key-1"));
    expect(key).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when the JWKS endpoint returns a non-200 status", async () => {
    const { fetchFn } = createMockFetch({ keys: [] }, { status: 500 });
    const provider = createJwksProvider({ teamDomainUrl: TEAM_DOMAIN_URL, fetchFn });
    const key = await provider.getKey(unsignedJwt("key-1"));
    expect(key).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns undefined when the matching JWK cannot be imported", async () => {
    const { provider } = createProvider({
      keys: [{ kid: "bad-1", kty: "RSA", n: "", e: "" } as JsonWebKey],
    });
    const key = await provider.getKey(unsignedJwt("bad-1"));
    expect(key).toBeUndefined();
  });

  it("imports an EC P-256 key", async () => {
    const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & {
      kid?: string;
    };
    jwk.kid = "ec-1";
    jwk.use = "sig";
    jwk.alg = "ES256";
    const { provider } = createProvider({ keys: [jwk] });
    const key = await provider.getKey(unsignedJwt("ec-1"));
    expect(key).toBeDefined();
    expect(key!.algorithm.name).toBe("ECDSA");
  });

  it("does not call fetch when the JWT header is missing a kid", async () => {
    const { fetchFn } = createMockFetch({ keys: [] });
    const provider = createJwksProvider({ teamDomainUrl: TEAM_DOMAIN_URL, fetchFn });
    const jwt = `${base64UrlEncode(JSON.stringify({ alg: "RS256" }))}.${base64UrlEncode(
      JSON.stringify({ sub: "x" }),
    )}.`;
    expect(await provider.getKey(jwt)).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns undefined when the JWT header decodes to invalid JSON", async () => {
    const { fetchFn } = createMockFetch({ keys: [] });
    const provider = createJwksProvider({ teamDomainUrl: TEAM_DOMAIN_URL, fetchFn });
    const badHeader = base64UrlEncode("not-json");
    const payload = base64UrlEncode(JSON.stringify({ sub: "x" }));
    expect(await provider.getKey(`${badHeader}.${payload}.sig`)).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns undefined when the JWT header base64 is malformed", async () => {
    const { fetchFn } = createMockFetch({ keys: [] });
    const provider = createJwksProvider({ teamDomainUrl: TEAM_DOMAIN_URL, fetchFn });
    // Three segments, but the first segment contains characters that make atob fail.
    expect(await provider.getKey("!!!.payload.sig")).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("imports an RSA-PSS key", async () => {
    const keyPair = (await crypto.subtle.generateKey(
      {
        name: "RSA-PSS",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & {
      kid?: string;
    };
    jwk.kid = "ps-1";
    jwk.use = "sig";
    jwk.alg = "PS256";
    const { provider } = createProvider({ keys: [jwk] });
    const key = await provider.getKey(unsignedJwt("ps-1"));
    expect(key).toBeDefined();
    expect(key!.algorithm.name).toBe("RSA-PSS");
  });

  it("imports an RSA-PSS key that can verify a real PSS signature", async () => {
    const keyPair = (await crypto.subtle.generateKey(
      {
        name: "RSA-PSS",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & {
      kid?: string;
    };
    jwk.kid = "ps-2";
    jwk.use = "sig";
    jwk.alg = "PS256";

    const { fetchFn } = createMockFetch({ keys: [jwk] });
    const provider = createJwksProvider({ teamDomainUrl: TEAM_DOMAIN_URL, fetchFn });

    const header = base64UrlEncode(JSON.stringify({ alg: "PS256", kid: "ps-2" }));
    const body = base64UrlEncode(JSON.stringify({ sub: "test-user" }));
    const data = new TextEncoder().encode(`${header}.${body}`);
    const signature = await crypto.subtle.sign(
      { name: "RSA-PSS", hash: "SHA-256", saltLength: 32 },
      keyPair.privateKey,
      data,
    );
    const sig = base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
    const jwt = `${header}.${body}.${sig}`;

    const key = await provider.getKey(jwt);
    expect(key).toBeDefined();
    expect(key!.algorithm.name).toBe("RSA-PSS");

    const valid = await crypto.subtle.verify(
      { name: "RSA-PSS", hash: "SHA-256", saltLength: 32 },
      key!,
      signature,
      data,
    );
    expect(valid).toBe(true);
  });

  it("imports an RS384 key with the correct hash algorithm", async () => {
    const keyPair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-384",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & {
      kid?: string;
    };
    jwk.kid = "rs384-1";
    jwk.use = "sig";
    jwk.alg = "RS384";
    const { provider } = createProvider({ keys: [jwk] });
    const key = await provider.getKey(unsignedJwt("rs384-1"));
    expect(key).toBeDefined();
    expect(key!.algorithm.name).toBe("RSASSA-PKCS1-v1_5");
    expect((key!.algorithm as { hash?: { name?: string } }).hash?.name).toBe("SHA-384");
  });

  it("imports an ES384 key with the correct hash and curve", async () => {
    const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & {
      kid?: string;
    };
    jwk.kid = "es384-1";
    jwk.use = "sig";
    jwk.alg = "ES384";
    const { provider } = createProvider({ keys: [jwk] });
    const key = await provider.getKey(unsignedJwt("es384-1"));
    expect(key).toBeDefined();
    expect(key!.algorithm.name).toBe("ECDSA");
    expect((key!.algorithm as { namedCurve?: string }).namedCurve).toBe("P-384");
  });

  it("imports an RS512 key with the correct hash algorithm", async () => {
    const keyPair = (await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-512",
      },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & {
      kid?: string;
    };
    jwk.kid = "rs512-1";
    jwk.use = "sig";
    jwk.alg = "RS512";
    const { provider } = createProvider({ keys: [jwk] });
    const key = await provider.getKey(unsignedJwt("rs512-1"));
    expect(key).toBeDefined();
    expect(key!.algorithm.name).toBe("RSASSA-PKCS1-v1_5");
    expect((key!.algorithm as { hash?: { name?: string } }).hash?.name).toBe("SHA-512");
  });

  it("imports an ES512 key with the correct curve", async () => {
    const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-521" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & {
      kid?: string;
    };
    jwk.kid = "es512-1";
    jwk.use = "sig";
    jwk.alg = "ES512";
    const { provider } = createProvider({ keys: [jwk] });
    const key = await provider.getKey(unsignedJwt("es512-1"));
    expect(key).toBeDefined();
    expect(key!.algorithm.name).toBe("ECDSA");
    expect((key!.algorithm as { namedCurve?: string }).namedCurve).toBe("P-521");
  });

  it("defaults an EC key to P-256 when crv is missing", async () => {
    const keyPair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey & {
      kid?: string;
    };
    jwk.kid = "ec-no-crv-1";
    jwk.use = "sig";
    jwk.alg = "ES256";
    delete jwk.crv;
    const { provider } = createProvider({ keys: [jwk] });
    const key = await provider.getKey(unsignedJwt("ec-no-crv-1"));
    expect(key).toBeDefined();
    expect(key!.algorithm.name).toBe("ECDSA");
    expect((key!.algorithm as { namedCurve?: string }).namedCurve).toBe("P-256");
  });

  it("falls back to the default logError logger on KV write failure", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const kv = new FakeKV();
    kv.failPut = true;
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fetchFn } = createMockFetch({ keys: [jwk] });
    const provider = createJwksProvider({
      teamDomainUrl: TEAM_DOMAIN_URL,
      kv: asKvNamespace(kv),
      fetchFn,
    });
    const key = await provider.getKey(unsignedJwt("key-1"));
    expect(key).toBeDefined();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("uses the default fetchFn and logError when neither is provided", async () => {
    const { jwk } = await generateKeyPair("key-1");
    const kv = new FakeKV();
    const { fetchFn } = createMockFetch({ keys: [jwk] });
    // Use the real fetch default by not passing fetchFn; avoid a network call by using a
    // malformed JWT so the provider returns before calling fetch.
    const provider = createJwksProvider({
      teamDomainUrl: TEAM_DOMAIN_URL,
      kv: asKvNamespace(kv),
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await provider.getKey("not-a-jwt")).toBeUndefined();
    // On a valid JWT the default fetchFn is invoked via our mock KV. We pre-seed KV so the
    // provider never reaches the real network.
    await kv.put(JWKS_CACHE_KEY, JSON.stringify({ keys: [jwk] }), {
      expirationTtl: JWKS_CACHE_TTL,
    });
    const key = await provider.getKey(unsignedJwt("key-1"));
    expect(key).toBeDefined();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
