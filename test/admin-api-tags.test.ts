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
import { createTagsRepository } from "../src/tags-repository";

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

describe("Tags — API integration", () => {
  let privateKey: CryptoKey;
  let fetchMock: ReturnType<typeof createMockFetch>;

  beforeEach(async () => {
    const keys = await generateKeyPair("access-key-1");
    privateKey = keys.privateKey;
    fetchMock = createMockFetch({ keys: [keys.jwk] });
    vi.stubGlobal("fetch", fetchMock.fetchFn);
    await env.DB.prepare("DELETE FROM page_tags").run();
    await env.DB.prepare("DELETE FROM pages").run();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await env.DB.prepare("DELETE FROM page_tags").run();
    await env.DB.prepare("DELETE FROM pages").run();
  });

  async function validToken(): Promise<string> {
    return signJwt(privateKey, "access-key-1", buildAccessPayload());
  }

  async function authHeaders(): Promise<Headers> {
    const h = new Headers();
    h.set("Cf-Access-Jwt-Assertion", await validToken());
    return h;
  }

  it("POST /api/pages with multipart form accepts tags", async () => {
    const formData = new FormData();
    const htmlContent = "<h1>Test</h1>";
    formData.append(
      "file:index.html",
      new Blob([htmlContent], { type: "text/html" }),
      "index.html",
    );
    formData.append("manifest", JSON.stringify({ slug: "tagged-page", tags: ["blog", "tech"] }));
    const req = new Request("https://pages.example.com/api/pages", {
      method: "POST",
      headers: await authHeaders(),
      body: formData,
    });
    const res = await worker.fetch(
      req,
      makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD }),
      createExecutionContext(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tags).toEqual(["blog", "tech"]);
  });

  it("POST /api/pages with JSON paste accepts tags", async () => {
    const req = new Request("https://pages.example.com/api/pages", {
      method: "POST",
      headers: {
        ...Object.fromEntries((await authHeaders()).entries()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content: "# Hello",
        format: "markdown",
        slug: "paste-tagged",
        title: "Paste Tagged",
        tags: ["blog", "news"],
      }),
    });
    const res = await worker.fetch(
      req,
      makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD }),
      createExecutionContext(),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tags).toEqual(["blog", "news"]);
  });

  it("GET /api/pages includes tags in list response", async () => {
    // Create a page with tags
    const tagsRepo = createTagsRepository(env.DB);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO pages (id, slug, title, kind, rev, entry_path, show_source, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(
        "page0tags",
        "tagged-list",
        "Tagged List",
        "html",
        1,
        "index.html",
        0,
        "public",
        now,
        now,
      )
      .run();
    await tagsRepo.setForPage("page0tags", ["alpha", "beta"]);

    const req = new Request("https://pages.example.com/api/pages", {
      headers: await authHeaders(),
    });
    const res = await worker.fetch(
      req,
      makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD }),
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    const page = body.find((p) => p.id === "page0tags");
    expect(page).toBeDefined();
    expect(page!.tags).toEqual(["alpha", "beta"]);
  });

  it("GET /api/pages/:id includes tags", async () => {
    const tagsRepo = createTagsRepository(env.DB);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO pages (id, slug, title, kind, rev, entry_path, show_source, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("page0det", "tag-detail", "Tag Detail", "html", 1, "index.html", 0, "public", now, now)
      .run();
    await tagsRepo.setForPage("page0det", ["gamma"]);

    const req = new Request("https://pages.example.com/api/pages/page0det", {
      headers: await authHeaders(),
    });
    const res = await worker.fetch(
      req,
      makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD }),
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tags).toEqual(["gamma"]);
  });

  it("PATCH /api/pages/:id updates tags", async () => {
    const tagsRepo = createTagsRepository(env.DB);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO pages (id, slug, title, kind, rev, entry_path, show_source, visibility, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind("page0upd", "tag-update", "Tag Update", "html", 1, "index.html", 0, "public", now, now)
      .run();
    await tagsRepo.setForPage("page0upd", ["old"]);

    const req = new Request("https://pages.example.com/api/pages/page0upd", {
      method: "PATCH",
      headers: {
        ...Object.fromEntries((await authHeaders()).entries()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags: ["new", "updated"] }),
    });
    const res = await worker.fetch(
      req,
      makeEnv({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN, ACCESS_AUD: ACCESS_AUD }),
      createExecutionContext(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.tags).toEqual(["new", "updated"]);
  });
});
