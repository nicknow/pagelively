import { describe, expect, it, vi, type Mock } from "vitest";
import { envToSetupOptions, parseTruthy, runSetup } from "../setup.mjs";

// S21: headless (non-interactive / CI) mode for setup.mjs.
// The interactive behaviors are covered in setup.mjs.test.ts; this file
// exercises ONLY the headless additions, with the same mock-based discipline
// (no real Cloudflare API calls, no real wrangler subprocesses).

interface ApiResponse {
  ok: boolean;
  status: number;
  json: () => Promise<Record<string, unknown>>;
}

type ApiCaller = (
  method: string,
  path: string,
  body?: unknown,
  opts?: unknown,
) => Promise<ApiResponse>;

type WranglerCaller = (
  args: string[],
  opts?: unknown,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

interface Deps {
  fs: {
    readFile: (path: string, encoding?: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
  };
  wrangler: Mock<WranglerCaller>;
  api: Mock<ApiCaller>;
  prompt: Mock<(message: string, defaultValue?: string) => Promise<string>>;
  confirm: Mock<(message: string, defaultValue?: boolean) => Promise<boolean>>;
  log: (message: string) => void;
  pause: Mock<(message: string) => Promise<void>>;
  env: Record<string, string>;
  _calls: { logs: string[]; writes: { path: string; content: string }[] };
}

const PLACEHOLDER_TOML = String.raw`name = "pagelively"
main = "src/index.ts"
compatibility_date = "2026-06-29"

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
ASSET_BASE_URL = "https://cdn.example.com"
ACCESS_TEAM_DOMAIN = "yourteam.cloudflareaccess.com"
ACCESS_AUD = "00000000000000000000000000000000000000000000000000"
`;

function ok(body: Record<string, unknown>): ApiResponse {
  return { ok: true, status: 200, json: async () => ({ success: true, ...body }) };
}

/** Happy-path responder: nothing exists, everything creates successfully. */
function createFirstRunResponder(
  accountId = "acc-123",
  appId = "app-123",
  aud = "aud-123",
  dbId = "d1-123",
  bucketName = "pagelively-assets",
  kvId = "kv-123",
): ApiCaller {
  return async (method: string, path: string) => {
    if (method === "GET" && path === `/accounts/${accountId}/access/apps`)
      return ok({ result: [] });
    if (method === "POST" && path === `/accounts/${accountId}/access/apps`)
      return ok({
        result: {
          id: appId,
          aud,
          name: "pagelively admin",
        },
      });
    if (method === "GET" && path === `/accounts/${accountId}/access/apps/${appId}/policies`)
      return ok({ result: [] });
    if (method === "POST" && path === `/accounts/${accountId}/access/apps/${appId}/policies`)
      return ok({ result: { id: "policy-123" } });
    if (method === "GET" && path.startsWith("/zones"))
      return ok({ result: [{ id: "zone-123", name: "example.com" }] });
    if (method === "GET" && path === `/accounts/${accountId}/r2/buckets`)
      return ok({ result: { buckets: [] } });
    if (method === "POST" && path === `/accounts/${accountId}/r2/buckets`)
      return ok({ result: { name: bucketName } });
    if (method === "POST" && path.includes("/domains/custom"))
      return ok({ result: { domain: "cdn.pages.example.com", status: "active" } });
    if (method === "GET" && path === `/accounts/${accountId}/d1/database`)
      return ok({ result: [] });
    if (method === "POST" && path === `/accounts/${accountId}/d1/database`)
      return ok({ result: { uuid: dbId, name: "pagelively-db" } });
    if (method === "GET" && path === `/accounts/${accountId}/storage/kv/namespaces`)
      return ok({ result: [] });
    if (method === "POST" && path === `/accounts/${accountId}/storage/kv/namespaces`)
      return ok({ result: { id: kvId } });
    throw new Error(`unexpected API call: ${method} ${path}`);
  };
}

function makeDeps(apiImpl: ApiCaller): Deps {
  const calls = { logs: [] as string[], writes: [] as { path: string; content: string }[] };
  const deps: Deps = {
    fs: {
      readFile: vi.fn(async () => PLACEHOLDER_TOML),
      writeFile: vi.fn(async (path: string, content: string) => {
        calls.writes.push({ path, content });
      }),
    },
    api: vi.fn(async (...args: unknown[]) => {
      return await apiImpl(...(args as [string, string, unknown, unknown]));
    }),
    wrangler: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    prompt: vi.fn(async () => ""),
    confirm: vi.fn(async () => true),
    log: vi.fn((message: string) => calls.logs.push(message)),
    pause: vi.fn(async () => undefined),
    env: {},
    _calls: calls,
  };
  return deps;
}

describe("setup.mjs headless env mapping helpers", () => {
  it("parseTruthy: 1, true, yes (any case) are truthy", () => {
    expect(parseTruthy("1")).toBe(true);
    expect(parseTruthy("true")).toBe(true);
    expect(parseTruthy("yes")).toBe(true);
    expect(parseTruthy("TRUE")).toBe(true);
    expect(parseTruthy("Yes")).toBe(true);
    expect(parseTruthy(" 1 ")).toBe(true);
  });

  it("parseTruthy: any other defined value is falsy", () => {
    expect(parseTruthy("0")).toBe(false);
    expect(parseTruthy("no")).toBe(false);
    expect(parseTruthy("false")).toBe(false);
    expect(parseTruthy("2")).toBe(false);
    expect(parseTruthy("maybe")).toBe(false);
  });

  it("parseTruthy: unset/empty is undefined (treated as not provided)", () => {
    expect(parseTruthy(undefined)).toBeUndefined();
    expect(parseTruthy(null)).toBeUndefined();
    expect(parseTruthy("")).toBeUndefined();
  });

  it("envToSetupOptions maps all SETUP_* / ADMIN_EMAILS env vars", () => {
    expect(
      envToSetupOptions({
        SETUP_WORKER_DOMAIN: "pages.example.com",
        SETUP_CDN_DOMAIN: "cdn.pages.example.com",
        SETUP_PROJECT_NAME: "pagelively",
        ADMIN_EMAILS: "admin@example.com, ops@example.com",
        SETUP_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
        SETUP_CREATE_KV: "1",
        SETUP_NON_INTERACTIVE: "yes",
        UNRELATED: "ignored",
      }),
    ).toEqual({
      workerDomain: "pages.example.com",
      cdnDomain: "cdn.pages.example.com",
      projectName: "pagelively",
      adminEmails: "admin@example.com, ops@example.com",
      accessTeamDomain: "team.cloudflareaccess.com",
      createKv: true,
      headless: true,
    });
  });

  it("envToSetupOptions: SETUP_ACCESS_TEAM_DOMAIN maps to accessTeamDomain only when set", () => {
    expect(
      envToSetupOptions({ SETUP_ACCESS_TEAM_DOMAIN: "yourteam.cloudflareaccess.com" }),
    ).toEqual({
      workerDomain: undefined,
      cdnDomain: undefined,
      projectName: undefined,
      adminEmails: undefined,
      accessTeamDomain: "yourteam.cloudflareaccess.com",
      headless: false,
    });
    expect(envToSetupOptions({}).accessTeamDomain).toBeUndefined();
  });

  it("envToSetupOptions: SETUP_CREATE_KV falsy maps to createKv false", () => {
    expect(envToSetupOptions({ SETUP_CREATE_KV: "0" })).toMatchObject({ createKv: false });
  });

  it("envToSetupOptions: unset create-kv leaves createKv undefined and headless false", () => {
    const opts = envToSetupOptions({});
    expect(opts.createKv).toBeUndefined();
    expect(opts.headless).toBe(false);
    expect(opts.workerDomain).toBeUndefined();
  });
});

describe("setup.mjs runSetup headless mode", () => {
  it("headless with all values: no prompt/confirm/pause calls, provisions and deploys", async () => {
    const deps = makeDeps(createFirstRunResponder());
    deps.env = { SETUP_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" };
    await runSetup(
      {
        headless: true,
        accountId: "acc-123",
        apiToken: "token-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        adminEmails: "admin@example.com",
        createKv: true,
      },
      deps,
    );
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps.pause).not.toHaveBeenCalled();
    const wranglerCommands = deps.wrangler.mock.calls.map((c) => c[0].join(" "));
    expect(wranglerCommands).toContain("d1 migrations apply pagelively-db --remote");
    expect(wranglerCommands).toContain("deploy");
    expect(deps.fs.writeFile).toHaveBeenCalled();
  });

  it("headless falls back to prompt defaults and the confirm default without calling them", async () => {
    // workerDomain/cdnDomain/projectName not provided -> prompt defaults apply;
    // createKv not provided -> confirm default (true) applies.
    const deps = makeDeps(createFirstRunResponder());
    deps.env = { SETUP_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" };
    await runSetup(
      {
        headless: true,
        accountId: "acc-123",
        apiToken: "token-123",
        adminEmails: "admin@example.com",
      },
      deps,
    );
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
    expect(deps._calls.logs.some((m) => m.includes("pages.example.com"))).toBe(true);
    expect(deps.api.mock.calls.some((c) => c[1].includes("/storage/kv/namespaces"))).toBe(true);
    const wranglerCommands = deps.wrangler.mock.calls.map((c) => c[0].join(" "));
    expect(wranglerCommands).toContain("deploy");
  });

  it("headless without CLOUDFLARE_API_TOKEN throws a clear error and never runs wrangler login", async () => {
    const deps = makeDeps(createFirstRunResponder());
    await expect(
      runSetup(
        {
          headless: true,
          accountId: "acc-123",
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
          adminEmails: "admin@example.com",
        },
        deps,
      ),
    ).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
    expect(deps.wrangler.mock.calls.some((c) => c[0].includes("login"))).toBe(false);
  });

  it("headless without admin emails throws a clear error naming ADMIN_EMAILS", async () => {
    const deps = makeDeps(createFirstRunResponder());
    await expect(
      runSetup(
        {
          headless: true,
          accountId: "acc-123",
          apiToken: "token-123",
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
        },
        deps,
      ),
    ).rejects.toThrow(/ADMIN_EMAILS/);
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  it("headless with Zero Trust not initialized prints the steps and throws instead of pausing", async () => {
    const accountId = "acc-123";
    const deps = makeDeps(async (method: string, path: string) => {
      if (method === "GET" && path === `/accounts/${accountId}/access/apps`) {
        return {
          ok: false,
          status: 403,
          json: async () => ({
            success: false,
            errors: [{ code: 1000, message: "Access not enabled" }],
          }),
        };
      }
      throw new Error(`unexpected API call: ${method} ${path}`);
    });
    await expect(
      runSetup(
        {
          headless: true,
          accountId,
          apiToken: "token-123",
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
          adminEmails: "admin@example.com",
        },
        deps,
      ),
    ).rejects.toThrow(/Zero Trust/);
    expect(deps._calls.logs.some((m) => m.includes("one.dash.cloudflare.com"))).toBe(true);
    expect(deps.pause).not.toHaveBeenCalled();
    const deployCalls = deps.wrangler.mock.calls.filter((c) => c[0].includes("deploy"));
    expect(deployCalls).toHaveLength(0);
  });

  // --- Validator-added edge/regression tests (S21 validation) ----------------

  it("headless + skipAuth + no token still throws and never runs wrangler login", async () => {
    // skipAuth must not let headless mode fall through to a silent unauthenticated
    // run: a missing token is a hard, deterministic error in CI.
    const deps = makeDeps(createFirstRunResponder());
    await expect(
      runSetup(
        {
          headless: true,
          skipAuth: true,
          accountId: "acc-123",
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
          adminEmails: "admin@example.com",
        },
        deps,
      ),
    ).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
    expect(deps.wrangler.mock.calls.some((c) => c[0].includes("login"))).toBe(false);
  });

  it("headless with the token supplied only via env (as the workflow does) proceeds", async () => {
    const deps = makeDeps(createFirstRunResponder());
    deps.env = {
      CLOUDFLARE_API_TOKEN: "token-123",
      CLOUDFLARE_ACCOUNT_ID: "acc-123",
      SETUP_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
    };
    await runSetup(
      {
        headless: true,
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        adminEmails: "admin@example.com",
      },
      deps,
    );
    expect(deps.wrangler.mock.calls.some((c) => c[0].includes("login"))).toBe(false);
    const wranglerCommands = deps.wrangler.mock.calls.map((c) => c[0].join(" "));
    expect(wranglerCommands).toContain("deploy");
  });

  it("headless without a resolvable account ID throws naming CLOUDFLARE_ACCOUNT_ID", async () => {
    const deps = makeDeps(createFirstRunResponder());
    deps.wrangler = vi.fn(async () => ({ stdout: "no account here", stderr: "", exitCode: 0 }));
    await expect(
      runSetup(
        {
          headless: true,
          apiToken: "token-123",
          workerDomain: "pages.example.com",
          cdnDomain: "cdn.pages.example.com",
          projectName: "pagelively",
          adminEmails: "admin@example.com",
        },
        deps,
      ),
    ).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  it("headless with createKv=false never calls the KV namespaces API", async () => {
    const deps = makeDeps(createFirstRunResponder());
    deps.env = { SETUP_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" };
    await runSetup(
      {
        headless: true,
        apiToken: "token-123",
        accountId: "acc-123",
        workerDomain: "pages.example.com",
        cdnDomain: "cdn.pages.example.com",
        projectName: "pagelively",
        adminEmails: "admin@example.com",
        createKv: false,
      },
      deps,
    );
    expect(deps.api.mock.calls.some((c) => c[1].includes("/storage/kv/namespaces"))).toBe(false);
    expect(deps.fs.writeFile).toHaveBeenCalled();
  });
});
