import { describe, expect, it, vi, type Mock } from "vitest";
import {
  deriveBucketName,
  deriveDbName,
  deriveKvName,
  normalizeDomain,
  parseAdminEmails,
  runSetup,
  updateWranglerToml,
} from "../setup.mjs";

// Mock-based unit tests for the human-run setup.mjs provisioning script.
// The script is dependency-injected: no real Cloudflare API calls, wrangler
// subprocesses, or filesystem writes occur here.

interface ApiResponse {
  ok: boolean;
  status: number;
  json: () => Promise<Record<string, unknown>>;
}

type ApiMethod = string;
type ApiPath = string;

type ApiCaller = (
  method: ApiMethod,
  path: ApiPath,
  body?: unknown,
  opts?: unknown,
) => Promise<ApiResponse>;

type WranglerCaller = (
  args: string[],
  opts?: unknown,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

interface ApiScenario {
  match: (method: ApiMethod, path: ApiPath) => boolean;
  response: (
    method: ApiMethod,
    path: ApiPath,
    body: unknown,
    opts: unknown,
  ) => Promise<ApiResponse>;
}

interface Deps {
  fs: {
    readFile: (path: string, encoding?: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
  };
  wrangler: Mock<WranglerCaller>;
  api: Mock<ApiCaller>;
  prompt: (message: string, defaultValue?: string) => Promise<string>;
  confirm: (message: string, defaultValue?: boolean) => Promise<boolean>;
  log: (message: string) => void;
  pause: (message: string) => Promise<void>;
  env: Record<string, string>;
  _calls: {
    wrangler: unknown[][];
    api: unknown[][];
    writes: { path: string; content: string }[];
    logs: string[];
    pauses: string[];
  };
}

const PLACEHOLDER_WRANGLER_TOML = String.raw`name = "pagelively"
main = "src/index.ts"
compatibility_date = "2026-06-29"

[cache]
enabled = true

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "pagelively-assets"

[[d1_databases]]
binding = "DB"
database_name = "pagelively-db"
database_id = "00000000-0000-0000-0000-000000000000"

# Optional KV namespace
# [[kv_namespaces]]
# binding = "KV"
# id = "00000000000000000000000000000000"

[vars]
SITE_NAME = "Pagelively"
ASSET_BASE_URL = "https://cdn.example.com"
HOME_MODE = "404"
HOME_PAGE_SLUG = ""
ALLOW_RAW_HTML_IN_MD = "true"
PUBLIC_LISTING = "false"
ACCESS_TEAM_DOMAIN = "yourteam.cloudflareaccess.com"
ACCESS_AUD = "00000000000000000000000000000000000000000000000000"
`;

type DepsOverrides = Partial<Omit<Deps, "api" | "wrangler">> & {
  api?: ApiCaller;
  wrangler?: WranglerCaller;
};

function makeDeps(overrides: DepsOverrides = {}) {
  const calls = {
    wrangler: [] as unknown[][],
    api: [] as unknown[][],
    writes: [] as { path: string; content: string }[],
    logs: [] as string[],
    pauses: [] as string[],
  };

  const apiImpl: ApiCaller =
    (overrides.api as ApiCaller) ||
    (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: [] }),
    }));
  const wranglerImpl: WranglerCaller =
    (overrides.wrangler as WranglerCaller) ||
    (async () => ({ stdout: "", stderr: "", exitCode: 0 }));

  const deps: Deps = {
    fs: {
      readFile: vi.fn(async () => PLACEHOLDER_WRANGLER_TOML),
      writeFile: vi.fn(async (path: string, content: string) => {
        calls.writes.push({ path, content });
      }),
    },
    api: vi.fn(async (...args: unknown[]) => {
      calls.api.push(args);
      return await apiImpl(...(args as [ApiMethod, ApiPath, unknown, unknown]));
    }),
    wrangler: vi.fn(async (...args: unknown[]) => {
      calls.wrangler.push(args);
      return await wranglerImpl(...(args as [string[], unknown]));
    }),
    prompt: vi.fn(async (message: string, defaultValue?: string) => defaultValue ?? ""),
    confirm: vi.fn(async () => true),
    log: vi.fn((message: string) => calls.logs.push(message)),
    pause: vi.fn(async (message: string) => {
      calls.pauses.push(message);
    }),
    env: {},
    _calls: calls,
  };

  return deps;
}

function apiResponder(scenarios: ApiScenario[]): ApiCaller {
  return async (method: ApiMethod, path: ApiPath, body?: unknown, opts?: unknown) => {
    for (const scenario of scenarios) {
      if (scenario.match(method, path)) {
        return scenario.response(method, path, body, opts);
      }
    }
    return { ok: true, status: 200, json: async () => ({ success: true, result: [] }) };
  };
}

interface WranglerScenario {
  match: string;
  response: (
    args: string[],
    opts: unknown,
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

function wranglerResponder(scenarios: WranglerScenario[]): WranglerCaller {
  return async (args: string[], opts?: unknown) => {
    const command = args.join(" ");
    for (const scenario of scenarios) {
      if (command.includes(scenario.match)) {
        return scenario.response(args, opts);
      }
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  };
}

function withApiOverrides(baseResponder: ApiCaller, overrides: ApiScenario[]): ApiCaller {
  return async (method: ApiMethod, path: ApiPath, body?: unknown, opts?: unknown) => {
    for (const scenario of overrides) {
      if (scenario.match(method, path)) {
        return scenario.response(method, path, body, opts);
      }
    }
    return baseResponder(method, path, body, opts);
  };
}

function withWranglerOverrides(
  baseWrangler: WranglerCaller,
  overrides: WranglerScenario[],
): WranglerCaller {
  return async (args: string[], opts?: unknown) => {
    const command = args.join(" ");
    for (const scenario of overrides) {
      if (command.includes(scenario.match)) {
        return scenario.response(args, opts);
      }
    }
    return baseWrangler(args, opts);
  };
}

interface ResponderIds {
  accountId?: string;
  appId?: string;
  policyId?: string;
  bucketName?: string;
  dbId?: string;
  kvId?: string;
  workerZoneId?: string;
  cdnZoneId?: string;
  aud?: string;
}

function makeCreateFirstRunResponder(ids: ResponderIds) {
  const appId = ids.appId ?? "app-123";
  const bucketName = ids.bucketName ?? "pagelively-assets";
  const dbId = ids.dbId ?? "d1-123";
  const kvId = ids.kvId ?? "kv-123";
  const accountId = ids.accountId ?? "acc-123";
  const workerZoneId = ids.workerZoneId ?? "zone-worker-123";
  const cdnZoneId = ids.cdnZoneId ?? "zone-cdn-123";
  const aud = ids.aud ?? "aud-123";

  return apiResponder([
    {
      match: (m, p) => m === "GET" && p === `/accounts/${accountId}/access/apps`,
      response: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: [] }),
      }),
    },
    {
      match: (m, p) => m === "POST" && p === `/accounts/${accountId}/access/apps`,
      response: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: {
            id: appId,
            aud,
            name: "Pagelively Admin",
            domain: "pages.example.com",
            type: "self_hosted",
          },
        }),
      }),
    },
    {
      match: (m, p) => m === "POST" && p === `/accounts/${accountId}/access/apps/${appId}/policies`,
      response: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { id: "policy-123" } }),
      }),
    },
    {
      match: (m, p) => m === "GET" && p.startsWith("/zones"),
      response: async (method, path) => {
        const name = new URLSearchParams(path.split("?")[1]).get("name");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: name?.includes("cdn.")
              ? [{ id: cdnZoneId, name: "cdn.pages.example.com" }]
              : [{ id: workerZoneId, name: "pages.example.com" }],
          }),
        };
      },
    },
    {
      match: (m, p) => m === "GET" && p === `/accounts/${accountId}/r2/buckets`,
      response: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { buckets: [] } }),
      }),
    },
    {
      match: (m, p) => m === "POST" && p === `/accounts/${accountId}/r2/buckets`,
      response: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { name: bucketName } }),
      }),
    },
    {
      match: (m, p) =>
        m === "POST" && p === `/accounts/${accountId}/r2/buckets/${bucketName}/domains/custom`,
      response: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { domain: "cdn.pages.example.com", status: "active" },
        }),
      }),
    },
    {
      match: (m, p) => m === "GET" && p === `/accounts/${accountId}/d1/database`,
      response: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: [] }),
      }),
    },
    {
      match: (m, p) => m === "POST" && p === `/accounts/${accountId}/d1/database`,
      response: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { uuid: dbId, name: "pagelively-db" },
        }),
      }),
    },
    {
      match: (m, p) => m === "GET" && p === `/accounts/${accountId}/storage/kv/namespaces`,
      response: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: [] }),
      }),
    },
    {
      match: (m, p) => m === "POST" && p === `/accounts/${accountId}/storage/kv/namespaces`,
      response: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { id: kvId } }),
      }),
    },
    {
      match: (m, p) => m === "GET" && p === `/accounts/${accountId}/access/apps/${appId}`,
      response: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: { id: appId, aud, name: "Pagelively Admin" },
        }),
      }),
    },
  ]);
}

describe("setup.mjs helpers", () => {
  it("parseAdminEmails splits comma-separated emails", () => {
    expect(parseAdminEmails("a@x.com, b@y.com")).toEqual(["a@x.com", "b@y.com"]);
  });

  it("parseAdminEmails trims whitespace and semicolons", () => {
    expect(parseAdminEmails("  a@x.com ; b@y.com  , c@z.com ")).toEqual([
      "a@x.com",
      "b@y.com",
      "c@z.com",
    ]);
  });

  it("parseAdminEmails returns empty array for empty input", () => {
    expect(parseAdminEmails("")).toEqual([]);
    expect(parseAdminEmails(undefined)).toEqual([]);
  });

  it("normalizeDomain strips scheme and lowercases", () => {
    expect(normalizeDomain("https://Pages.Example.COM")).toBe("pages.example.com");
    expect(normalizeDomain("http://cdn.pages.example.com/")).toBe("cdn.pages.example.com");
  });

  it("deriveBucketName sanitizes project name", () => {
    expect(deriveBucketName("My Project")).toBe("my-project-assets");
    expect(deriveBucketName("pagelively")).toBe("pagelively-assets");
  });

  it("deriveDbName and deriveKvName follow the same convention", () => {
    expect(deriveDbName("My Project")).toBe("my-project-db");
    expect(deriveKvName("My Project")).toBe("my-project-kv");
  });
});

describe("setup.mjs runSetup", () => {
  it("first run creates all resources, writes wrangler.toml, applies migrations, and deploys", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      policyId: "policy-123",
      bucketName: "pagelively-assets",
      dbId: "d1-123",
      kvId: "kv-123",
      workerZoneId: "zone-worker-123",
      cdnZoneId: "zone-cdn-123",
      aud: "aud-123",
    };
    const teamDomain = "team.cloudflareaccess.com";
    const deps = makeDeps({ api: makeCreateFirstRunResponder(ids) });

    await runSetup(
      {
        accountId: ids.accountId,
        apiToken: "token-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        accessTeamDomain: teamDomain,
        adminEmails: "admin@example.com",
        createKv: true,
      },
      deps,
    );

    // Resource creation calls
    const apiCreateCalls = deps.api.mock.calls.filter((c) => c[0] === "POST");
    expect(apiCreateCalls.map((c) => c[1])).toContain(`/accounts/${ids.accountId}/r2/buckets`);
    expect(apiCreateCalls.map((c) => c[1])).toContain(`/accounts/${ids.accountId}/d1/database`);
    expect(apiCreateCalls.map((c) => c[1])).toContain(
      `/accounts/${ids.accountId}/storage/kv/namespaces`,
    );
    expect(apiCreateCalls.map((c) => c[1])).toContain(`/accounts/${ids.accountId}/access/apps`);
    expect(apiCreateCalls.map((c) => c[1])).toContain(
      `/accounts/${ids.accountId}/access/apps/${ids.appId}/policies`,
    );
    expect(apiCreateCalls.map((c) => c[1])).toContain(
      `/accounts/${ids.accountId}/r2/buckets/${ids.bucketName}/domains/custom`,
    );

    // Wrangler calls
    const wranglerCommands = deps.wrangler.mock.calls.map((c) => c[0].join(" "));
    expect(wranglerCommands).toContain("d1 migrations apply pagelively-db --remote");
    expect(wranglerCommands).toContain("deploy");

    // wrangler.toml was written with real IDs
    expect(deps.fs.writeFile).toHaveBeenCalled();
    const written = deps._calls.writes[0].content;
    expect(written).toContain(`database_id = "${ids.dbId}"`);
    expect(written).toContain(`bucket_name = "${ids.bucketName}"`);
    expect(written).toContain(`ASSET_BASE_URL = "https://cdn.pages.example.com"`);
    expect(written).toContain(`ACCESS_AUD = "${ids.aud}"`);
    expect(written).toContain(`ACCESS_TEAM_DOMAIN = "${teamDomain}"`);
    expect(written).toContain(`[[kv_namespaces]]`);
    expect(written).toContain(`id = "${ids.kvId}"`);
    expect(written).toContain(`pattern = "pages.example.com"`);
    expect(written).toContain(`custom_domain = true`);

    // URLs printed
    expect(deps._calls.logs.some((m) => m.includes("https://pages.example.com"))).toBe(true);
    expect(deps._calls.logs.some((m) => m.includes("https://cdn.pages.example.com"))).toBe(true);
    expect(deps._calls.logs.some((m) => m.includes("/admin"))).toBe(true);
  });

  it("second run is idempotent: lists resources, no POST create calls", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
      kvId: "kv-123",
    };

    const existingApp = {
      id: ids.appId,
      aud: ids.aud,
      name: "Pagelively Admin",
      domain: "pages.example.com",
      type: "self_hosted",
      policies: [
        {
          id: "policy-123",
          decision: "allow",
          include: [{ email: { email: "admin@example.com" } }],
        },
      ],
    };

    const responder = apiResponder([
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/access/apps`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: [existingApp] }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/r2/buckets`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: { buckets: [{ name: ids.bucketName }] },
          }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/d1/database`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [{ uuid: ids.dbId, name: "pagelively-db" }],
          }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/storage/kv/namespaces`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: [{ id: ids.kvId, title: "pagelively-kv" }] }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p.startsWith("/zones"),
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [{ id: "zone-123", name: "pages.example.com" }],
          }),
        }),
      },
      {
        match: (m, p) =>
          m === "GET" && p === `/accounts/${ids.accountId}/access/apps/${ids.appId}/policies`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [{ id: "policy-123", name: "pagelively allow-admins", decision: "allow" }],
          }),
        }),
      },
      {
        match: (m, p) => m === "POST" && p.includes("/domains/custom"),
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: { domain: "cdn.pages.example.com", status: "active" },
          }),
        }),
      },
    ]);

    const deps = makeDeps({ api: responder });
    await runSetup(
      {
        accountId: ids.accountId,
        apiToken: "token-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        accessTeamDomain: "team.cloudflareaccess.com",
        adminEmails: "admin@example.com",
        createKv: true,
      },
      deps,
    );

    const postCalls = deps.api.mock.calls.filter((c) => c[0] === "POST");
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0][1]).toBe(
      `/accounts/${ids.accountId}/r2/buckets/${ids.bucketName}/domains/custom`,
    );
  });

  it("uses token auth when CLOUDFLARE_API_TOKEN is provided", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = makeCreateFirstRunResponder(ids);
    const deps = makeDeps({ api: responder });
    await runSetup(
      {
        accountId: ids.accountId,
        apiToken: "token-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        accessTeamDomain: "team.cloudflareaccess.com",
        adminEmails: "admin@example.com",
      },
      deps,
    );
    expect(deps._calls.logs.some((m) => m.includes("API token"))).toBe(true);
    expect(deps.wrangler).not.toHaveBeenCalledWith(
      expect.arrayContaining(["login"]),
      expect.anything(),
    );
  });

  it("prompts for wrangler login when no token is provided", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = makeCreateFirstRunResponder(ids);
    const wrangler = wranglerResponder([
      {
        match: "login",
        response: async () => ({ stdout: "Successfully logged in", stderr: "", exitCode: 0 }),
      },
    ]);
    const deps = makeDeps({ api: responder, wrangler });
    await runSetup(
      {
        accountId: ids.accountId,
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        accessTeamDomain: "team.cloudflareaccess.com",
        adminEmails: "admin@example.com",
      },
      deps,
    );
    const loginCalls = deps.wrangler.mock.calls.filter((c) => c[0].includes("login"));
    expect(loginCalls.length).toBeGreaterThan(0);
  });

  it("pauses with Zero Trust setup steps when Access returns not-initialized error", async () => {
    const ids = { accountId: "acc-123" };
    const responder = apiResponder([
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/access/apps`,
        response: async () => ({
          ok: false,
          status: 403,
          json: async () => ({
            success: false,
            errors: [{ code: 1000, message: "Access not enabled" }],
          }),
        }),
      },
    ]);
    const deps = makeDeps({ api: responder });
    await runSetup(
      {
        accountId: ids.accountId,
        apiToken: "token-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        accessTeamDomain: "team.cloudflareaccess.com",
        adminEmails: "admin@example.com",
      },
      deps,
    );
    expect(deps._calls.pauses.length).toBeGreaterThan(0);
    expect(deps._calls.pauses.some((m) => m.toLowerCase().includes("zero trust"))).toBe(true);
    expect(deps._calls.logs.some((m) => m.includes("zero trust") || m.includes("Zero Trust"))).toBe(
      true,
    );
    const deployCalls = deps.wrangler.mock.calls.filter((c) => c[0].includes("deploy"));
    expect(deployCalls).toHaveLength(0);
  });

  it("stops with a clear pre-deploy error when the zone does not exist", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = apiResponder([
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/access/apps`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [{ id: ids.appId, aud: ids.aud, name: "Pagelively Admin" }],
          }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p.startsWith("/zones"),
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: [] }),
        }),
      },
    ]);
    const deps = makeDeps({ api: responder });
    await runSetup(
      {
        accountId: ids.accountId,
        apiToken: "token-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        accessTeamDomain: "team.cloudflareaccess.com",
        adminEmails: "admin@example.com",
      },
      deps,
    );
    expect(
      deps._calls.logs.some(
        (m) => m.includes("zone") && (m.includes("not found") || m.includes("missing")),
      ),
    ).toBe(true);
    const deployCalls = deps.wrangler.mock.calls.filter((c) => c[0].includes("deploy"));
    expect(deployCalls).toHaveLength(0);
  });

  it("partial-failure resume: R2 exists, D1 missing, creates D1 and continues", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
      kvId: "kv-123",
    };
    const responder = apiResponder([
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/access/apps`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [{ id: ids.appId, aud: ids.aud, name: "Pagelively Admin" }],
          }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p.startsWith("/zones"),
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [{ id: "zone-123", name: "pages.example.com" }],
          }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/r2/buckets`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: { buckets: [{ name: ids.bucketName }] } }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/d1/database`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: [] }),
        }),
      },
      {
        match: (m, p) => m === "POST" && p === `/accounts/${ids.accountId}/d1/database`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: { uuid: ids.dbId, name: "pagelively-db" } }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/storage/kv/namespaces`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: [{ id: ids.kvId, title: "pagelively-kv" }] }),
        }),
      },
      {
        match: (m, p) => m === "POST" && p.includes("/domains/custom"),
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: { domain: "cdn.pages.example.com", status: "active" },
          }),
        }),
      },
    ]);
    const deps = makeDeps({ api: responder });
    await runSetup(
      {
        accountId: ids.accountId,
        apiToken: "token-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        accessTeamDomain: "team.cloudflareaccess.com",
        adminEmails: "admin@example.com",
      },
      deps,
    );
    const postCalls = deps.api.mock.calls.filter((c) => c[0] === "POST");
    const createD1 = postCalls.find((c) => c[1] === `/accounts/${ids.accountId}/d1/database`);
    expect(createD1).toBeTruthy();
    const deployCalls = deps.wrangler.mock.calls.filter((c) => c[0].includes("deploy"));
    expect(deployCalls).toHaveLength(1);
  });

  it("admin email parsing: multiple and comma-separated become email rules", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
      kvId: "kv-123",
    };
    const responder = makeCreateFirstRunResponder(ids);
    const deps = makeDeps({ api: responder });
    await runSetup(
      {
        accountId: ids.accountId,
        apiToken: "token-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        accessTeamDomain: "team.cloudflareaccess.com",
        adminEmails: "admin@example.com, operator@example.com",
      },
      deps,
    );
    const policyCall = deps.api.mock.calls.find(
      (c) =>
        c[0] === "POST" && c[1] === `/accounts/${ids.accountId}/access/apps/${ids.appId}/policies`,
    );
    expect(policyCall).toBeTruthy();
    const body = policyCall![2] as { include: { email: { email: string } }[] };
    expect(body.include).toHaveLength(2);
    expect(body.include.map((r: { email: { email: string } }) => r.email.email)).toContain(
      "admin@example.com",
    );
    expect(body.include.map((r: { email: { email: string } }) => r.email.email)).toContain(
      "operator@example.com",
    );
  });

  it("throws when admin emails are missing or empty", async () => {
    const deps = makeDeps();
    await expect(
      runSetup(
        {
          accountId: "acc-123",
          apiToken: "token-123",
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
          adminEmails: "",
        },
        deps,
      ),
    ).rejects.toThrow("At least one admin email");
  });

  it("resolves account ID from wrangler whoami output when not provided", async () => {
    const ids = {
      accountId: "abc123def45678901234567890123456",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = makeCreateFirstRunResponder(ids);
    const wrangler = wranglerResponder([
      {
        match: "whoami",
        response: async () => ({
          stdout: "Account ID abc123def45678901234567890123456",
          stderr: "",
          exitCode: 0,
        }),
      },
    ]);
    const deps = makeDeps({ api: responder, wrangler });
    await runSetup(
      {
        apiToken: "token-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        accessTeamDomain: "team.cloudflareaccess.com",
        adminEmails: "admin@example.com",
      },
      deps,
    );
    expect(
      deps.api.mock.calls.some((c) =>
        c[1].startsWith("/accounts/abc123def45678901234567890123456"),
      ),
    ).toBe(true);
  });

  it("prompts for account ID when wrangler whoami provides none", async () => {
    const ids = {
      accountId: "prompted-acc",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = makeCreateFirstRunResponder(ids);
    const wrangler = wranglerResponder([
      {
        match: "whoami",
        response: async () => ({ stdout: "No account info", stderr: "", exitCode: 0 }),
      },
    ]);
    const deps = makeDeps({ api: responder, wrangler });
    deps.prompt = vi.fn(async () => "prompted-acc");
    await runSetup(
      {
        apiToken: "token-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        accessTeamDomain: "team.cloudflareaccess.com",
        adminEmails: "admin@example.com",
      },
      deps,
    );
    expect(deps.api.mock.calls.some((c) => c[1].startsWith("/accounts/prompted-acc"))).toBe(true);
  });

  it("throws when account ID cannot be resolved", async () => {
    const wrangler = wranglerResponder([
      {
        match: "whoami",
        response: async () => ({ stdout: "No account info", stderr: "", exitCode: 0 }),
      },
    ]);
    const deps = makeDeps({ wrangler });
    deps.prompt = vi.fn(async () => "");
    await expect(
      runSetup(
        {
          apiToken: "token-123",
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
          adminEmails: "admin@example.com",
        },
        deps,
      ),
    ).rejects.toThrow("Cloudflare account ID is required");
  });

  it("throws when Access application creation fails", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = withApiOverrides(makeCreateFirstRunResponder(ids), [
      {
        match: (m, p) => m === "POST" && p === `/accounts/${ids.accountId}/access/apps`,
        response: async () => ({
          ok: false,
          status: 400,
          json: async () => ({ success: false, errors: [{ message: "invalid app" }] }),
        }),
      },
    ]);
    const deps = makeDeps({ api: responder });
    await expect(
      runSetup(
        {
          accountId: ids.accountId,
          apiToken: "token-123",
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
          accessTeamDomain: "team.cloudflareaccess.com",
          adminEmails: "admin@example.com",
        },
        deps,
      ),
    ).rejects.toThrow("Failed to create Access application");
  });

  it("throws when Access policy creation fails", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = withApiOverrides(makeCreateFirstRunResponder(ids), [
      {
        match: (m, p) =>
          m === "POST" && p === `/accounts/${ids.accountId}/access/apps/${ids.appId}/policies`,
        response: async () => ({
          ok: false,
          status: 400,
          json: async () => ({ success: false, errors: [{ message: "invalid policy" }] }),
        }),
      },
    ]);
    const deps = makeDeps({ api: responder });
    await expect(
      runSetup(
        {
          accountId: ids.accountId,
          apiToken: "token-123",
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
          accessTeamDomain: "team.cloudflareaccess.com",
          adminEmails: "admin@example.com",
        },
        deps,
      ),
    ).rejects.toThrow("Failed to create Access policy");
  });

  it("throws when R2 bucket creation fails", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = withApiOverrides(makeCreateFirstRunResponder(ids), [
      {
        match: (m, p) => m === "POST" && p === `/accounts/${ids.accountId}/r2/buckets`,
        response: async () => ({
          ok: false,
          status: 400,
          json: async () => ({ success: false, errors: [{ message: "invalid bucket" }] }),
        }),
      },
    ]);
    const deps = makeDeps({ api: responder });
    await expect(
      runSetup(
        {
          accountId: ids.accountId,
          apiToken: "token-123",
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
          accessTeamDomain: "team.cloudflareaccess.com",
          adminEmails: "admin@example.com",
        },
        deps,
      ),
    ).rejects.toThrow("Failed to create R2 bucket");
  });

  it("throws when D1 database creation fails", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = withApiOverrides(makeCreateFirstRunResponder(ids), [
      {
        match: (m, p) => m === "POST" && p === `/accounts/${ids.accountId}/d1/database`,
        response: async () => ({
          ok: false,
          status: 400,
          json: async () => ({ success: false, errors: [{ message: "invalid database" }] }),
        }),
      },
    ]);
    const deps = makeDeps({ api: responder });
    await expect(
      runSetup(
        {
          accountId: ids.accountId,
          apiToken: "token-123",
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
          accessTeamDomain: "team.cloudflareaccess.com",
          adminEmails: "admin@example.com",
        },
        deps,
      ),
    ).rejects.toThrow("Failed to create D1 database");
  });

  it("throws when KV namespace creation fails", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
      kvId: "kv-123",
    };
    const responder = withApiOverrides(makeCreateFirstRunResponder(ids), [
      {
        match: (m, p) => m === "POST" && p === `/accounts/${ids.accountId}/storage/kv/namespaces`,
        response: async () => ({
          ok: false,
          status: 400,
          json: async () => ({ success: false, errors: [{ message: "invalid kv" }] }),
        }),
      },
    ]);
    const deps = makeDeps({ api: responder });
    await expect(
      runSetup(
        {
          accountId: ids.accountId,
          apiToken: "token-123",
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
          accessTeamDomain: "team.cloudflareaccess.com",
          adminEmails: "admin@example.com",
          createKv: true,
        },
        deps,
      ),
    ).rejects.toThrow("Failed to create KV namespace");
  });

  it("throws when R2 custom domain connection fails with a non-409 error", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = withApiOverrides(makeCreateFirstRunResponder(ids), [
      {
        match: (m, p) => m === "POST" && p.includes("/domains/custom"),
        response: async () => ({
          ok: false,
          status: 500,
          json: async () => ({ success: false, errors: [{ message: "domain error" }] }),
        }),
      },
    ]);
    const deps = makeDeps({ api: responder });
    await expect(
      runSetup(
        {
          accountId: ids.accountId,
          apiToken: "token-123",
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
          accessTeamDomain: "team.cloudflareaccess.com",
          adminEmails: "admin@example.com",
        },
        deps,
      ),
    ).rejects.toThrow("Failed to connect R2 custom domain");
  });

  it("treats 409 on R2 custom domain connection as already connected", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = withApiOverrides(makeCreateFirstRunResponder(ids), [
      {
        match: (m, p) => m === "POST" && p.includes("/domains/custom"),
        response: async () => ({
          ok: false,
          status: 409,
          json: async () => ({ success: false, errors: [{ message: "already exists" }] }),
        }),
      },
    ]);
    const deps = makeDeps({ api: responder });
    await runSetup(
      {
        accountId: ids.accountId,
        apiToken: "token-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        accessTeamDomain: "team.cloudflareaccess.com",
        adminEmails: "admin@example.com",
      },
      deps,
    );
    expect(deps._calls.logs.some((m) => m.includes("already connected"))).toBe(true);
    const deployCalls = deps.wrangler.mock.calls.filter((c) => c[0].includes("deploy"));
    expect(deployCalls).toHaveLength(1);
  });

  it("throws when D1 migrations apply fails", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = makeCreateFirstRunResponder(ids);
    const wrangler = withWranglerOverrides(
      async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      [
        {
          match: "d1 migrations apply",
          response: async () => ({ stdout: "", stderr: "migration failed", exitCode: 1 }),
        },
      ],
    );
    const deps = makeDeps({ api: responder, wrangler });
    await expect(
      runSetup(
        {
          accountId: ids.accountId,
          apiToken: "token-123",
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
          accessTeamDomain: "team.cloudflareaccess.com",
          adminEmails: "admin@example.com",
        },
        deps,
      ),
    ).rejects.toThrow("D1 migrations failed");
  });

  it("throws when wrangler deploy fails", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = makeCreateFirstRunResponder(ids);
    const wrangler = withWranglerOverrides(
      async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      [
        {
          match: "deploy",
          response: async () => ({ stdout: "", stderr: "deploy failed", exitCode: 1 }),
        },
      ],
    );
    const deps = makeDeps({ api: responder, wrangler });
    await expect(
      runSetup(
        {
          accountId: ids.accountId,
          apiToken: "token-123",
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
          accessTeamDomain: "team.cloudflareaccess.com",
          adminEmails: "admin@example.com",
        },
        deps,
      ),
    ).rejects.toThrow("wrangler deploy failed");
  });

  it("throws when wrangler login fails", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = makeCreateFirstRunResponder(ids);
    const wrangler = withWranglerOverrides(
      async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      [
        {
          match: "login",
          response: async () => ({ stdout: "", stderr: "login failed", exitCode: 1 }),
        },
      ],
    );
    const deps = makeDeps({ api: responder, wrangler });
    await expect(
      runSetup(
        {
          accountId: ids.accountId,
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
          accessTeamDomain: "team.cloudflareaccess.com",
          adminEmails: "admin@example.com",
        },
        deps,
      ),
    ).rejects.toThrow("wrangler login failed");
  });

  it("skips KV namespace when createKv is false", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = makeCreateFirstRunResponder(ids);
    const deps = makeDeps({ api: responder });
    await runSetup(
      {
        accountId: ids.accountId,
        apiToken: "token-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        accessTeamDomain: "team.cloudflareaccess.com",
        adminEmails: "admin@example.com",
        createKv: false,
      },
      deps,
    );
    expect(deps.api.mock.calls.some((c) => c[1].includes("/storage/kv/namespaces"))).toBe(false);
    const written = deps._calls.writes[0].content;
    expect(written).toContain("# [[kv_namespaces]]");
    expect(written).not.toMatch(/^\[\[kv_namespaces\]\]$/m);
  });

  it("skips Access policy creation when a matching policy already exists", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = apiResponder([
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/access/apps`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [
              {
                id: ids.appId,
                aud: ids.aud,
                name: "Pagelively Admin",
                domain: "pages.example.com",
              },
            ],
          }),
        }),
      },
      {
        match: (m, p) =>
          m === "GET" && p === `/accounts/${ids.accountId}/access/apps/${ids.appId}/policies`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [{ id: "policy-123", name: "pagelively allow-admins", decision: "allow" }],
          }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p.startsWith("/zones"),
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [{ id: "zone-123", name: "pages.example.com" }],
          }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/r2/buckets`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: { buckets: [{ name: ids.bucketName }] } }),
        }),
      },
      {
        match: (m, p) => m === "POST" && p.includes("/domains/custom"),
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: { domain: "cdn.pages.example.com", status: "active" },
          }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/d1/database`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [{ uuid: ids.dbId, name: "pagelively-db" }],
          }),
        }),
      },
    ]);
    const deps = makeDeps({ api: responder });
    await runSetup(
      {
        accountId: ids.accountId,
        apiToken: "token-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        accessTeamDomain: "team.cloudflareaccess.com",
        adminEmails: "admin@example.com",
      },
      deps,
    );
    const policyPostCalls = deps.api.mock.calls.filter(
      (c) => c[0] === "POST" && c[1].includes("/policies"),
    );
    expect(policyPostCalls).toHaveLength(0);
    expect(deps._calls.logs.some((m) => m.includes("Access policy already exists"))).toBe(true);
  });

  it("fetches full Access app details when aud or team domain is missing from the list", async () => {
    const ids = {
      accountId: "acc-123",
      appId: "app-123",
      aud: "aud-123",
      dbId: "d1-123",
      bucketName: "pagelively-assets",
    };
    const responder = apiResponder([
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/access/apps`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [{ id: ids.appId, name: "Pagelively Admin", domain: "pages.example.com" }],
          }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/access/apps/${ids.appId}`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: {
              id: ids.appId,
              aud: ids.aud,
              name: "Pagelively Admin",
              team_domain: "team.cloudflareaccess.com",
            },
          }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p.startsWith("/zones"),
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [{ id: "zone-123", name: "pages.example.com" }],
          }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/r2/buckets`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ success: true, result: { buckets: [{ name: ids.bucketName }] } }),
        }),
      },
      {
        match: (m, p) => m === "POST" && p.includes("/domains/custom"),
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: { domain: "cdn.pages.example.com", status: "active" },
          }),
        }),
      },
      {
        match: (m, p) => m === "GET" && p === `/accounts/${ids.accountId}/d1/database`,
        response: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            result: [{ uuid: ids.dbId, name: "pagelively-db" }],
          }),
        }),
      },
    ]);
    const deps = makeDeps({ api: responder });
    await runSetup(
      {
        accountId: ids.accountId,
        apiToken: "token-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        adminEmails: "admin@example.com",
      },
      deps,
    );
    expect(
      deps.api.mock.calls.some(
        (c) => c[1] === `/accounts/${ids.accountId}/access/apps/${ids.appId}`,
      ),
    ).toBe(true);
    const written = deps._calls.writes[0].content;
    expect(written).toContain(`ACCESS_AUD = "${ids.aud}"`);
    expect(written).toContain(`ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"`);
  });

  it("does not double-consume the Access apps response body on a not-initialized error", async () => {
    let jsonCalls = 0;
    const responder = apiResponder([
      {
        match: (m, p) => m === "GET" && p === "/accounts/acc-123/access/apps",
        response: async () => ({
          ok: false,
          status: 403,
          json: async () => {
            jsonCalls++;
            if (jsonCalls > 1) throw new Error("response.json() called twice");
            return { success: false, errors: [{ code: 1000, message: "Access not enabled" }] };
          },
        }),
      },
    ]);
    const deps = makeDeps({ api: responder });
    await runSetup(
      {
        accountId: "acc-123",
        apiToken: "token-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        adminEmails: "admin@example.com",
      },
      deps,
    );
    expect(jsonCalls).toBe(1);
    expect(deps._calls.pauses.length).toBeGreaterThan(0);
  });

  it("throws when Node.js version is below the minimum", async () => {
    const deps = makeDeps();
    await expect(runSetup({ minNodeVersion: 99 }, deps)).rejects.toThrow(
      "Node.js >= 99 is required",
    );
  });

  it("does not auto-run the CLI entry point when the module is imported", async () => {
    const module = await import("../setup.mjs");
    expect(module.runSetup).toBeTypeOf("function");
    expect((module as Record<string, unknown>).main).toBeUndefined();
  });
});

describe("setup.mjs updateWranglerToml", () => {
  it("preserves existing comments and vars when updating values", () => {
    const toml = `# Custom header comment
name = "pagelively"
main = "src/index.ts"
compatibility_date = "2026-06-29"

[vars]
SITE_NAME = "Pagelively"
ASSET_BASE_URL = "https://cdn.example.com"
# Keep this comment
HOME_MODE = "404"
ACCESS_TEAM_DOMAIN = "yourteam.cloudflareaccess.com"
ACCESS_AUD = "00000000000000000000000000000000000000000000000000"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "old-bucket"

[[d1_databases]]
binding = "DB"
database_name = "pagelively-db"
database_id = "00000000-0000-0000-0000-000000000000"

# Optional KV namespace
# [[kv_namespaces]]
# binding = "KV"
# id = "00000000000000000000000000000000"
`;
    const updated = updateWranglerToml(toml, {
      bucketName: "new-bucket",
      dbId: "d1-new",
      assetBaseUrl: "https://cdn.new.com",
      accessTeamDomain: "newteam.cloudflareaccess.com",
      accessAud: "aud-new",
      kvId: "kv-new",
      workerDomain: "pages.example.com",
    });
    expect(updated).toContain("# Custom header comment");
    expect(updated).toContain("# Keep this comment");
    expect(updated).toContain(`bucket_name = "new-bucket"`);
    expect(updated).toContain(`database_id = "d1-new"`);
    expect(updated).toContain(`ASSET_BASE_URL = "https://cdn.new.com"`);
    expect(updated).toContain(`ACCESS_TEAM_DOMAIN = "newteam.cloudflareaccess.com"`);
    expect(updated).toContain(`ACCESS_AUD = "aud-new"`);
    expect(updated).toContain(`id = "kv-new"`);
    expect(updated).toContain(`pattern = "pages.example.com"`);
    expect(updated).toContain(`custom_domain = true`);
    expect(updated).not.toContain(`bucket_name = "old-bucket"`);
    expect(updated).not.toContain(`database_id = "00000000-0000-0000-0000-000000000000"`);
    expect(updated).not.toContain(`ASSET_BASE_URL = "https://cdn.example.com"`);
  });

  it("does not duplicate the routes block when run repeatedly", () => {
    const toml = `name = "pagelively"\n[vars]\nASSET_BASE_URL = "https://cdn.example.com"\nACCESS_TEAM_DOMAIN = "yourteam.cloudflareaccess.com"\nACCESS_AUD = "00000000000000000000000000000000000000000000000000"\n`;
    const once = updateWranglerToml(toml, { workerDomain: "pages.example.com" });
    const twice = updateWranglerToml(once, { workerDomain: "pages.example.com" });
    expect((twice.match(/\[\[routes\]\]/g) || []).length).toBe(1);
    expect((twice.match(/pattern = "pages.example.com"/g) || []).length).toBe(1);
  });

  it("uncomments and updates an existing KV block when kvId is provided", () => {
    const toml = `# Optional KV\n# [[kv_namespaces]]\n# binding = "KV"\n# id = "old-kv-id"\n`;
    const updated = updateWranglerToml(toml, { kvId: "kv-new" });
    expect(updated).toContain("[[kv_namespaces]]");
    expect(updated).toContain(`id = "kv-new"`);
    expect(updated).not.toContain("# [[kv_namespaces]]");
    expect(updated).not.toContain("old-kv-id");
  });

  it("does not interpret $ in replacement values as special regex patterns", () => {
    const toml = `name = "pagelively"\n[vars]\nASSET_BASE_URL = "https://cdn.example.com"\nACCESS_TEAM_DOMAIN = "yourteam.cloudflareaccess.com"\nACCESS_AUD = "00000000000000000000000000000000000000000000000000"\n`;
    const updated = updateWranglerToml(toml, {
      assetBaseUrl: "https://cdn.example.com/$path",
      accessTeamDomain: "team$123.cloudflareaccess.com",
      accessAud: "aud$special",
      workerDomain: "pages.example.com",
    });
    expect(updated).toContain(`ASSET_BASE_URL = "https://cdn.example.com/$path"`);
    expect(updated).toContain(`ACCESS_TEAM_DOMAIN = "team$123.cloudflareaccess.com"`);
    expect(updated).toContain(`ACCESS_AUD = "aud$special"`);
    expect(updated).toContain(`pattern = "pages.example.com"`);
  });
});
