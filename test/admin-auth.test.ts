import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import {
  ACCESS_AUD,
  base64UrlDecode,
  base64UrlEncode,
  createMockFetch,
  generateKeyPair,
  signJwt,
  TEAM_DOMAIN,
  TEAM_DOMAIN_URL,
} from "./jwt-test-helpers";

// S16 — End-to-end admin/API JWT gate wiring in src/index.ts.
// Uses a mock JWKS endpoint so no real Cloudflare Access is needed.

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return { ...env, ...overrides } as Env;
}

function buildAccessPayload(overrides: object = {}): object {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: TEAM_DOMAIN_URL,
    aud: [ACCESS_AUD],
    iat: now,
    exp: now + 3600,
    email: "admin@example.com",
    ...overrides,
  };
}

describe("index.ts — admin/api JWT gate", () => {
  let privateKey: CryptoKey;
  let fetchMock: ReturnType<typeof createMockFetch>;

  beforeEach(async () => {
    const keys = await generateKeyPair("access-key-1");
    privateKey = keys.privateKey;
    fetchMock = createMockFetch({ keys: [keys.jwk] });
    vi.stubGlobal("fetch", fetchMock.fetchFn);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function fetchAdmin(path: string, token?: string): Promise<Response> {
    const headers = token ? new Headers({ "Cf-Access-Jwt-Assertion": token }) : new Headers();
    const request = new Request(`https://pages.example.com${path}`, { headers });
    const customEnv = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD });
    return worker.fetch(request, customEnv, createExecutionContext());
  }

  async function validToken(): Promise<string> {
    return signJwt(privateKey, "access-key-1", buildAccessPayload());
  }

  it("GET /admin without Cf-Access-Jwt-Assertion returns 403 Forbidden", async () => {
    const res = await fetchAdmin("/admin");
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({ error: "Forbidden", message: "Forbidden" });
  });

  it("GET /admin with a valid token returns the dashboard HTML", async () => {
    const res = await fetchAdmin("/admin", await validToken());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toContain("text/html");
    const text = await res.text();
    expect(text).toContain("Pagelively");
  });

  it("GET /api/pages without a token returns 403 Forbidden", async () => {
    const res = await fetchAdmin("/api/pages");
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Forbidden", message: "Forbidden" });
  });

  it("GET /api/pages with a valid token returns the page list JSON", async () => {
    const res = await fetchAdmin("/api/pages", await validToken());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual([]);
  });

  it("POST /api/pages with a valid token reaches the publish endpoint", async () => {
    const requestEnv = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD });
    const res = await worker.fetch(
      new Request("https://pages.example.com/api/pages", {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": await validToken() },
      }),
      requestEnv,
      createExecutionContext(),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "invalid_form_data",
      message: "Could not parse multipart form data.",
    });
  });

  it("GET /admin/dashboard with a valid token returns a 404 for an unknown admin path", async () => {
    const res = await fetchAdmin("/admin/dashboard", await validToken());
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("GET /admin with an expired token returns 403 Forbidden", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expiredToken = await signJwt(
      privateKey,
      "access-key-1",
      buildAccessPayload({ iat: now - 7200, exp: now - 3600 }),
    );
    const res = await fetchAdmin("/admin", expiredToken);
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Forbidden", message: "Forbidden" });
  });

  it("GET /admin with a tampered token returns 403 Forbidden", async () => {
    const token = await validToken();
    const [header, payload, signature] = token.split(".");
    const payloadObj = JSON.parse(base64UrlDecode(payload)) as { email: string };
    payloadObj.email = "attacker@example.com";
    const tamperedPayload = base64UrlEncode(JSON.stringify(payloadObj));
    const tampered = `${header}.${tamperedPayload}.${signature}`;
    const res = await fetchAdmin("/admin", tampered);
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Forbidden", message: "Forbidden" });
  });

  it("GET /api/pages with a forged token (unknown kid) returns 403 Forbidden", async () => {
    const { privateKey: unknownPrivateKey } = await generateKeyPair("unknown-key");
    const forgedToken = await signJwt(unknownPrivateKey, "unknown-key", buildAccessPayload());
    const res = await fetchAdmin("/api/pages", forgedToken);
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Forbidden", message: "Forbidden" });
  });

  it("PATCH /api/pages returns 405 method_not_allowed", async () => {
    const res = await worker.fetch(
      new Request("https://pages.example.com/api/pages", {
        method: "PATCH",
        headers: { "Cf-Access-Jwt-Assertion": await validToken() },
      }),
      makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD }),
      createExecutionContext(),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "method_not_allowed",
      message: "Method Not Allowed",
    });
  });

  it("DELETE /api/pages returns 405 method_not_allowed", async () => {
    const res = await worker.fetch(
      new Request("https://pages.example.com/api/pages", {
        method: "DELETE",
        headers: { "Cf-Access-Jwt-Assertion": await validToken() },
      }),
      makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD }),
      createExecutionContext(),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "method_not_allowed",
      message: "Method Not Allowed",
    });
  });

  it("PUT /api/pages returns 405 method_not_allowed", async () => {
    const res = await worker.fetch(
      new Request("https://pages.example.com/api/pages", {
        method: "PUT",
        headers: { "Cf-Access-Jwt-Assertion": await validToken() },
      }),
      makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD }),
      createExecutionContext(),
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "method_not_allowed",
      message: "Method Not Allowed",
    });
  });

  it("public routes remain unauthenticated", async () => {
    const health = await worker.fetch(
      new Request("https://pages.example.com/health"),
      env,
      createExecutionContext(),
    );
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, service: "pagelively" });

    const home = await worker.fetch(
      new Request("https://pages.example.com/"),
      env,
      createExecutionContext(),
    );
    expect(home.status).toBe(404);
    expect(home.headers.get("Cache-Control")).toBe("no-store");
  });
});
