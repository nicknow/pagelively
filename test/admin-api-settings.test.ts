import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import {
  ACCESS_AUD,
  createMockFetch,
  generateKeyPair,
  signJwt,
  TEAM_DOMAIN,
  TEAM_DOMAIN_URL,
} from "./jwt-test-helpers";

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

async function clearSettings(db: D1Database) {
  await db.prepare("DELETE FROM settings").run();
}

describe("Settings API", () => {
  let privateKey: CryptoKey;
  let fetchMock: ReturnType<typeof createMockFetch>;

  beforeEach(async () => {
    const keys = await generateKeyPair("access-key-1");
    privateKey = keys.privateKey;
    fetchMock = createMockFetch({ keys: [keys.jwk] });
    vi.stubGlobal("fetch", fetchMock.fetchFn);
    await clearSettings(env.DB);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearSettings(env.DB);
  });

  async function validToken(): Promise<string> {
    return signJwt(privateKey, "access-key-1", buildAccessPayload());
  }

  async function fetchSettings(method: string, body?: unknown): Promise<Response> {
    const token = await validToken();
    const headers = new Headers({ "Cf-Access-Jwt-Assertion": token });
    if (body) {
      headers.set("Content-Type", "application/json");
    }
    const request = new Request("https://pages.example.com/api/settings", {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const customEnv = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD });
    return worker.fetch(request, customEnv, createExecutionContext());
  }

  it("GET /api/settings returns current settings", async () => {
    // Seed a setting via the repository
    const { createSettingsRepository } = await import("../src/settings-repository");
    const repo = createSettingsRepository(env.DB);
    await repo.set("default_page", "my-home");

    const res = await fetchSettings("GET");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ default_page: "my-home" });
  });

  it("GET /api/settings returns empty object when no settings exist", async () => {
    const res = await fetchSettings("GET");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({});
  });

  it("PATCH /api/settings sets a setting", async () => {
    const res = await fetchSettings("PATCH", { default_page: "home-page" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ default_page: "home-page" });

    // Verify it's persisted
    const { createSettingsRepository } = await import("../src/settings-repository");
    const repo = createSettingsRepository(env.DB);
    expect(await repo.get("default_page")).toBe("home-page");
  });

  it("PATCH /api/settings overwrites existing settings", async () => {
    const { createSettingsRepository } = await import("../src/settings-repository");
    const repo = createSettingsRepository(env.DB);
    await repo.set("default_page", "old-home");

    await fetchSettings("PATCH", { default_page: "new-home" });
    const res = await fetchSettings("GET");
    const body = await res.json();
    expect(body).toEqual({ default_page: "new-home" });
  });

  it("PATCH /api/settings with empty string clears the setting", async () => {
    const { createSettingsRepository } = await import("../src/settings-repository");
    const repo = createSettingsRepository(env.DB);
    await repo.set("default_page", "my-home");

    await fetchSettings("PATCH", { default_page: "" });
    const res = await fetchSettings("GET");
    const body = await res.json();
    expect(body).toEqual({ default_page: "" });
  });

  it("PATCH /api/settings without a token returns 403", async () => {
    const request = new Request("https://pages.example.com/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ default_page: "test" }),
    });
    const customEnv = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD });
    const res = await worker.fetch(request, customEnv, createExecutionContext());
    expect(res.status).toBe(403);
  });

  it("PATCH /api/settings with invalid JSON returns 400", async () => {
    const token = await validToken();
    const headers = new Headers({
      "Cf-Access-Jwt-Assertion": token,
      "Content-Type": "application/json",
    });
    const request = new Request("https://pages.example.com/api/settings", {
      method: "PATCH",
      headers,
      body: "not-json",
    });
    const customEnv = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD });
    const res = await worker.fetch(request, customEnv, createExecutionContext());
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.error).toBe("invalid_json");
  });

  it("GET /api/settings without a token returns 403", async () => {
    const request = new Request("https://pages.example.com/api/settings");
    const customEnv = makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD });
    const res = await worker.fetch(request, customEnv, createExecutionContext());
    expect(res.status).toBe(403);
  });
});
