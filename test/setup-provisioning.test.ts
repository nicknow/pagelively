import { describe, expect, it, vi, type Mock } from "vitest";
import {
  envToSetupOptions,
  findCoveringZone,
  provisioningError,
  resolveTeamDomain,
  runSetup,
  zoneCandidates,
} from "../setup.mjs";

// Field-fix tests for setup.mjs provisioning (2026-08-01, +fix round):
//   - The Access app object has NO team_domain/access_app_id fields; the Zero
//     Trust team domain comes from GET /accounts/{id}/access/organizations ->
//     result.domain ?? result.auth_domain (the official schema documents
//     `auth_domain`; live accounts may return `domain` — both resolve, with
//     `domain` winning when both are present) or explicit input / env /
//     interactive prompt.
//   - GET /zones?name= is an exact match, so covering-zone lookup strips
//     leftmost labels (cdn.n.3a8r.com -> n.3a8r.com -> 3a8r.com). Inputs are
//     normalized (trailing dots stripped) and empty candidates are skipped, so
//     `/zones?name=` is never called with a blank name.
//   - R2 error 10042 (R2 not enabled) and D1 error 10000 (missing D1
//     permission) get actionable messages.
// All Cloudflare calls are mocked; nothing here touches the real API.

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

function ok(body: Record<string, unknown>): ApiResponse {
  return { ok: true, status: 200, json: async () => ({ success: true, ...body }) };
}

function err(status: number, errors: unknown[]): ApiResponse {
  return { ok: false, status, json: async () => ({ success: false, errors }) };
}

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
  _calls: {
    wrangler: unknown[][];
    api: unknown[][];
    writes: { path: string; content: string }[];
    logs: string[];
  };
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

const wranglerImpl: WranglerCaller = async () => ({ stdout: "", stderr: "", exitCode: 0 });

function makeDeps(apiImpl: ApiCaller): Deps {
  const calls = {
    wrangler: [] as unknown[][],
    api: [] as unknown[][],
    writes: [] as { path: string; content: string }[],
    logs: [] as string[],
  };
  const deps: Deps = {
    fs: {
      readFile: vi.fn(async () => PLACEHOLDER_TOML),
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
    prompt: vi.fn(async (_message: string, defaultValue?: string) => defaultValue ?? ""),
    confirm: vi.fn(async () => true),
    log: vi.fn((message: string) => calls.logs.push(message)),
    pause: vi.fn(async () => undefined),
    env: {},
    _calls: calls,
  };
  return deps;
}

interface RunIds {
  accountId: string;
  appId: string;
  aud: string;
  dbId: string;
  bucketName: string;
  workerZoneId: string;
  cdnZoneId: string;
}

const BASE_IDS: RunIds = {
  accountId: "acc-123",
  appId: "app-123",
  aud: "aud-123",
  dbId: "d1-123",
  bucketName: "pagelively-assets",
  workerZoneId: "zone-worker-123",
  cdnZoneId: "zone-cdn-123",
};

interface RunResponderOptions {
  orgDomain?: string;
  orgResponse?: () => Promise<ApiResponse>;
  zones?: Record<string, { id: string; name: string } | undefined>;
}

/** Full happy-path responder; `zones` keys are exact names (empty result otherwise). */
function makeRunResponder(ids: RunIds, opts: RunResponderOptions = {}): ApiCaller {
  const zones = opts.zones ?? {
    "pages.example.com": { id: ids.workerZoneId, name: "pages.example.com" },
  };
  const orgResponse = opts.orgResponse
    ? opts.orgResponse
    : async () => ok({ result: opts.orgDomain ? { domain: opts.orgDomain } : {} });
  return async (method: string, path: string) => {
    if (method === "GET" && path === `/accounts/${ids.accountId}/access/apps`)
      return ok({
        result: [
          {
            id: ids.appId,
            aud: ids.aud,
            name: "Pagelively Admin",
            domain: "pages.example.com",
            type: "self_hosted",
          },
        ],
      });
    if (method === "POST" && path === `/accounts/${ids.accountId}/access/apps`)
      return ok({
        result: { id: ids.appId, aud: ids.aud, name: "Pagelively admin", type: "self_hosted" },
      });
    if (method === "GET" && path === `/accounts/${ids.accountId}/access/organizations`)
      return orgResponse();
    if (method === "GET" && path === `/accounts/${ids.accountId}/access/apps/${ids.appId}/policies`)
      return ok({ result: [] });
    if (
      method === "POST" &&
      path === `/accounts/${ids.accountId}/access/apps/${ids.appId}/policies`
    )
      return ok({ result: { id: "policy-1" } });
    if (method === "GET" && path.startsWith("/zones")) {
      const name = new URLSearchParams(path.split("?")[1]).get("name") || "";
      const zone = zones[name];
      return ok({ result: zone ? [zone] : [] });
    }
    if (method === "GET" && path === `/accounts/${ids.accountId}/r2/buckets`)
      return ok({ result: { buckets: [] } });
    if (method === "POST" && path === `/accounts/${ids.accountId}/r2/buckets`)
      return ok({ result: { name: ids.bucketName } });
    if (method === "POST" && path.includes("/domains/custom"))
      return ok({ result: { domain: "cdn.pages.example.com", status: "active" } });
    if (method === "GET" && path === `/accounts/${ids.accountId}/d1/database`)
      return ok({ result: [] });
    if (method === "POST" && path === `/accounts/${ids.accountId}/d1/database`)
      return ok({ result: { uuid: ids.dbId, name: "pagelively-db" } });
    if (method === "GET" && path === `/accounts/${ids.accountId}/storage/kv/namespaces`)
      return ok({ result: [] });
    throw new Error(`unexpected API call: ${method} ${path}`);
  };
}

/** Wrap a responder so a matching call returns a custom response instead. */
function overrideApi(
  base: ApiCaller,
  match: (method: string, path: string) => boolean,
  response: () => Promise<ApiResponse>,
): ApiCaller {
  return async (method: string, path: string, body?: unknown, opts?: unknown) => {
    if (match(method, path)) return response();
    return base(method, path, body, opts);
  };
}

function baseOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: BASE_IDS.accountId,
    apiToken: "token-123",
    workerDomain: "pages.example.com",
    cdnDomain: "cdn.pages.example.com",
    projectName: "pagelively",
    adminEmails: "admin@example.com",
    createKv: false,
    ...extra,
  };
}

function teamDomainPrompt(deps: Deps, teamDomain: string): void {
  deps.prompt = vi.fn(async (message: string, defaultValue?: string) =>
    message.includes("Zero Trust team domain") ? teamDomain : (defaultValue ?? ""),
  );
}

const ORG_403 = async () => err(403, [{ code: 10000, message: "Authentication error" }]);

const ORG_500 = async () => err(500, [{ message: "boom" }]);

// ---------------------------------------------------------------------------
// resolveTeamDomain (unit level)
// ---------------------------------------------------------------------------

describe("resolveTeamDomain", () => {
  const noopPrompt = vi.fn(async () => "");

  it("returns the explicit accessTeamDomain option first", async () => {
    const api = vi.fn<ApiCaller>();
    const result = await resolveTeamDomain({
      accessTeamDomain: "opts.cloudflareaccess.com",
      env: { SETUP_ACCESS_TEAM_DOMAIN: "env.cloudflareaccess.com" },
      api,
      prompt: noopPrompt,
    });
    expect(result).toBe("opts.cloudflareaccess.com");
    expect(api).not.toHaveBeenCalled();
  });

  it("returns SETUP_ACCESS_TEAM_DOMAIN before calling the org endpoint", async () => {
    const api = vi.fn<ApiCaller>();
    const result = await resolveTeamDomain({
      env: { SETUP_ACCESS_TEAM_DOMAIN: "env.cloudflareaccess.com" },
      api,
      prompt: noopPrompt,
    });
    expect(result).toBe("env.cloudflareaccess.com");
    expect(api).not.toHaveBeenCalled();
  });

  it("reads result.domain from the org endpoint when nothing is provided", async () => {
    const api = vi.fn<ApiCaller>(async () =>
      ok({ result: { domain: "org.cloudflareaccess.com" } }),
    );
    const result = await resolveTeamDomain({
      accountId: "acc-123",
      api,
      prompt: noopPrompt,
    });
    expect(result).toBe("org.cloudflareaccess.com");
    expect(api.mock.calls[0][1]).toBe("/accounts/acc-123/access/organizations");
  });

  it("reads result.auth_domain when the org response has ONLY auth_domain (official schema shape)", async () => {
    const api = vi.fn<ApiCaller>(async () =>
      ok({ result: { auth_domain: "org.cloudflareaccess.com" } }),
    );
    const result = await resolveTeamDomain({
      accountId: "acc-123",
      api,
      prompt: noopPrompt,
    });
    expect(result).toBe("org.cloudflareaccess.com");
    expect(api.mock.calls[0][1]).toBe("/accounts/acc-123/access/organizations");
  });

  it("prefers result.domain over result.auth_domain when both are present (documented precedence)", async () => {
    const api = vi.fn<ApiCaller>(async () =>
      ok({
        result: {
          domain: "domain.cloudflareaccess.com",
          auth_domain: "auth.cloudflareaccess.com",
        },
      }),
    );
    const result = await resolveTeamDomain({
      accountId: "acc-123",
      api,
      prompt: noopPrompt,
    });
    expect(result).toBe("domain.cloudflareaccess.com");
  });

  it("swallows a 403 [10000] org response and falls through to the prompt", async () => {
    const api = vi.fn<ApiCaller>(async () => ORG_403());
    const prompt = vi.fn(async () => "prompted.cloudflareaccess.com");
    const result = await resolveTeamDomain({ accountId: "acc-123", api, prompt });
    expect(result).toBe("prompted.cloudflareaccess.com");
    expect(prompt).toHaveBeenCalledWith(
      "Zero Trust team domain (e.g. yourteam.cloudflareaccess.com):",
      "",
    );
  });

  it("throws a clear error naming SETUP_ACCESS_TEAM_DOMAIN when nothing resolves", async () => {
    const api = vi.fn<ApiCaller>(async () => ORG_403());
    await expect(
      resolveTeamDomain({ accountId: "acc-123", api, prompt: noopPrompt }),
    ).rejects.toThrow(/SETUP_ACCESS_TEAM_DOMAIN/);
  });
});

// ---------------------------------------------------------------------------
// envToSetupOptions
// ---------------------------------------------------------------------------

describe("envToSetupOptions SETUP_ACCESS_TEAM_DOMAIN", () => {
  it("maps SETUP_ACCESS_TEAM_DOMAIN into accessTeamDomain", () => {
    expect(
      envToSetupOptions({ SETUP_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" }),
    ).toMatchObject({ accessTeamDomain: "team.cloudflareaccess.com" });
  });

  it("leaves accessTeamDomain unset when the env var is absent", () => {
    expect(envToSetupOptions({}).accessTeamDomain).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// findCoveringZone / zoneCandidates
// ---------------------------------------------------------------------------

describe("findCoveringZone", () => {
  it("exact match: resolves the zone on the first attempt", async () => {
    const api = vi.fn<ApiCaller>(async (_m, p) => {
      const name = new URLSearchParams(p.split("?")[1]).get("name");
      return name === "pages.example.com"
        ? ok({ result: [{ id: "zone-1", name: "pages.example.com" }] })
        : ok({ result: [] });
    });
    const zone = await findCoveringZone("pages.example.com", api);
    expect(zone).toEqual({ id: "zone-1", name: "pages.example.com" });
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("one-strip: n.3a8r.com resolves to the 3a8r.com zone", async () => {
    const api = vi.fn<ApiCaller>(async (_m, p) => {
      const name = new URLSearchParams(p.split("?")[1]).get("name");
      return name === "3a8r.com"
        ? ok({ result: [{ id: "z", name: "3a8r.com" }] })
        : ok({ result: [] });
    });
    const zone = await findCoveringZone("n.3a8r.com", api);
    expect(zone).toEqual({ id: "z", name: "3a8r.com" });
    const paths = api.mock.calls.map((c) => c[1]);
    expect(paths).toEqual(["/zones?name=n.3a8r.com", "/zones?name=3a8r.com"]);
  });

  it("multi-strip: cdn.n.3a8r.com resolves to the 3a8r.com zone", async () => {
    const api = vi.fn<ApiCaller>(async (_m, p) => {
      const name = new URLSearchParams(p.split("?")[1]).get("name");
      return name === "3a8r.com"
        ? ok({ result: [{ id: "z", name: "3a8r.com" }] })
        : ok({ result: [] });
    });
    const zone = await findCoveringZone("cdn.n.3a8r.com", api);
    expect(zone).toEqual({ id: "z", name: "3a8r.com" });
    const paths = api.mock.calls.map((c) => c[1]);
    expect(paths).toEqual([
      "/zones?name=cdn.n.3a8r.com",
      "/zones?name=n.3a8r.com",
      "/zones?name=3a8r.com",
    ]);
  });

  it("returns undefined when no label has a covering zone (no throw)", async () => {
    const api = vi.fn<ApiCaller>(async () => ok({ result: [] }));
    const zone = await findCoveringZone("cdn.n.3a8r.com", api);
    expect(zone).toBeUndefined();
    expect(api).toHaveBeenCalledTimes(4);
  });

  it("throws with describeApiError details on a non-OK zone response", async () => {
    const api = vi.fn<ApiCaller>(async () => err(500, [{ code: 1000, message: "zone boom" }]));
    await expect(findCoveringZone("pages.example.com", api)).rejects.toThrow(
      "Failed to look up Cloudflare zone",
    );
    await expect(findCoveringZone("pages.example.com", api)).rejects.toThrow("500");
    await expect(findCoveringZone("pages.example.com", api)).rejects.toThrow("zone boom");
  });
});

describe("zoneCandidates", () => {
  it("normalizes and strips leftmost labels, keeping the full chain", () => {
    expect(zoneCandidates("HTTPS://Cdn.N.3a8r.COM/")).toEqual([
      "cdn.n.3a8r.com",
      "n.3a8r.com",
      "3a8r.com",
      "com",
    ]);
  });

  it("never emits an empty-string candidate (blank/pathological input yields [] or dotless chain)", () => {
    expect(zoneCandidates("")).toEqual([]);
    expect(zoneCandidates("   ")).toEqual([]);
    expect(zoneCandidates("...")).toEqual([]);
    expect(zoneCandidates("n.3a8r.com.")).not.toContain("");
  });
});

// ---------------------------------------------------------------------------
// provisioningError
// ---------------------------------------------------------------------------

describe("provisioningError", () => {
  it("maps R2 code 10042 to the actionable R2 message", async () => {
    const message = await provisioningError(
      err(400, [{ code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." }]),
      "Failed to list R2 buckets",
      [10042],
    );
    expect(message).toBe(
      "R2 is not enabled on this Cloudflare account. Enable it in the Cloudflare dashboard (R2 > Overview), then re-run.",
    );
  });

  it("maps D1 code 10000 to the actionable D1 message", async () => {
    const message = await provisioningError(
      err(400, [{ code: 10000, message: "Authentication error" }]),
      "Failed to list D1 databases",
      [10000],
    );
    expect(message).toBe(
      "The Cloudflare API token is missing the D1 permission. Add Account → D1: Edit (see docs/operations/README.md 'API token scopes'), then re-run.",
    );
  });

  it("keeps the describeApiError generic fallback for unmapped errors", async () => {
    const message = await provisioningError(
      err(400, [{ code: 9999, message: "something else" }]),
      "Failed to create R2 bucket",
      [10042],
    );
    expect(message).toBe("Failed to create R2 bucket (HTTP 400): [9999] something else");
  });

  it("tolerates an unreadable response body", async () => {
    const message = await provisioningError(
      {
        status: 502,
        json: async () => {
          throw new Error("body consumed");
        },
      },
      "Failed to list D1 databases",
      [10000],
    );
    expect(message).toBe("Failed to list D1 databases (HTTP 502)");
  });
});

// ---------------------------------------------------------------------------
// runSetup: team domain chain
// ---------------------------------------------------------------------------

describe("runSetup team domain chain", () => {
  it("resolves the team domain from the Zero Trust org endpoint", async () => {
    const deps = makeDeps(makeRunResponder(BASE_IDS, { orgDomain: "team.cloudflareaccess.com" }));
    await runSetup(baseOptions(), deps);
    const written = deps._calls.writes[0].content;
    expect(written).toContain('ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"');
    expect(written).toContain('ACCESS_AUD = "aud-123"');
  });

  it("resolves the team domain from an auth_domain-only org response (official schema shape)", async () => {
    const deps = makeDeps(
      makeRunResponder(BASE_IDS, {
        orgResponse: async () => ok({ result: { auth_domain: "team.cloudflareaccess.com" } }),
      }),
    );
    await runSetup(baseOptions(), deps);
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps._calls.writes[0].content).toContain(
      'ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"',
    );
  });

  it("headless resolves the team domain from the org endpoint without prompting", async () => {
    const deps = makeDeps(makeRunResponder(BASE_IDS, { orgDomain: "team.cloudflareaccess.com" }));
    await runSetup(baseOptions({ headless: true }), deps);
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps._calls.writes[0].content).toContain(
      'ACCESS_TEAM_DOMAIN = "team.cloudflareaccess.com"',
    );
  });

  it("falls back to the interactive prompt when the org endpoint returns 403 [10000]", async () => {
    const deps = makeDeps(makeRunResponder(BASE_IDS, { orgResponse: ORG_403 }));
    teamDomainPrompt(deps, "prompted.cloudflareaccess.com");
    await runSetup(baseOptions(), deps);
    expect(
      deps.prompt.mock.calls.some(([message]) => message.includes("Zero Trust team domain")),
    ).toBe(true);
    expect(deps._calls.writes[0].content).toContain(
      'ACCESS_TEAM_DOMAIN = "prompted.cloudflareaccess.com"',
    );
  });

  it("falls back to the interactive prompt on a non-OK org response (500)", async () => {
    const deps = makeDeps(makeRunResponder(BASE_IDS, { orgResponse: ORG_500 }));
    teamDomainPrompt(deps, "prompted.cloudflareaccess.com");
    await runSetup(baseOptions(), deps);
    expect(deps._calls.writes[0].content).toContain(
      'ACCESS_TEAM_DOMAIN = "prompted.cloudflareaccess.com"',
    );
  });

  it("interactive prompt flow: org returns no domain and the prompt supplies it", async () => {
    const deps = makeDeps(makeRunResponder(BASE_IDS, { orgDomain: undefined }));
    teamDomainPrompt(deps, "prompted.cloudflareaccess.com");
    await runSetup(baseOptions(), deps);
    expect(deps._calls.writes[0].content).toContain(
      'ACCESS_TEAM_DOMAIN = "prompted.cloudflareaccess.com"',
    );
  });

  it("headless success via SETUP_ACCESS_TEAM_DOMAIN (org endpoint never called)", async () => {
    const deps = makeDeps(makeRunResponder(BASE_IDS, { orgDomain: "org.cloudflareaccess.com" }));
    deps.env = { SETUP_ACCESS_TEAM_DOMAIN: "headless.cloudflareaccess.com" };
    await runSetup(baseOptions({ headless: true }), deps);
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps._calls.writes[0].content).toContain(
      'ACCESS_TEAM_DOMAIN = "headless.cloudflareaccess.com"',
    );
    expect(deps.api.mock.calls.some((c) => c[1].includes("/access/organizations"))).toBe(false);
  });

  it("headless with nothing resolved throws naming SETUP_ACCESS_TEAM_DOMAIN", async () => {
    const deps = makeDeps(makeRunResponder(BASE_IDS, { orgResponse: ORG_403 }));
    await expect(runSetup(baseOptions({ headless: true }), deps)).rejects.toThrow(
      /SETUP_ACCESS_TEAM_DOMAIN/,
    );
    expect(deps.prompt).not.toHaveBeenCalled();
  });

  it("SETUP_ACCESS_TEAM_DOMAIN beats the org endpoint (org never called)", async () => {
    const deps = makeDeps(makeRunResponder(BASE_IDS, { orgDomain: "org.cloudflareaccess.com" }));
    deps.env = { SETUP_ACCESS_TEAM_DOMAIN: "env.cloudflareaccess.com" };
    await runSetup(baseOptions(), deps);
    expect(deps._calls.writes[0].content).toContain(
      'ACCESS_TEAM_DOMAIN = "env.cloudflareaccess.com"',
    );
    expect(deps.api.mock.calls.some((c) => c[1].includes("/access/organizations"))).toBe(false);
  });

  it("explicit opts.accessTeamDomain beats the env var", async () => {
    const deps = makeDeps(makeRunResponder(BASE_IDS, { orgDomain: "org.cloudflareaccess.com" }));
    deps.env = { SETUP_ACCESS_TEAM_DOMAIN: "env.cloudflareaccess.com" };
    await runSetup(baseOptions({ accessTeamDomain: "opts.cloudflareaccess.com" }), deps);
    expect(deps._calls.writes[0].content).toContain(
      'ACCESS_TEAM_DOMAIN = "opts.cloudflareaccess.com"',
    );
    expect(deps.api.mock.calls.some((c) => c[1].includes("/access/organizations"))).toBe(false);
  });

  it("throws a clear error when the interactive prompt is answered empty", async () => {
    const deps = makeDeps(makeRunResponder(BASE_IDS, { orgResponse: ORG_403 }));
    const error = await runSetup(baseOptions(), deps).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Access team domain/i);
    expect((error as Error).message).toMatch(/SETUP_ACCESS_TEAM_DOMAIN/);
  });

  it("keeps resolving aud from the app object without a detail fetch", async () => {
    const deps = makeDeps(makeRunResponder(BASE_IDS, { orgDomain: "team.cloudflareaccess.com" }));
    await runSetup(baseOptions(), deps);
    expect(deps._calls.writes[0].content).toContain('ACCESS_AUD = "aud-123"');
    expect(
      deps.api.mock.calls.some(
        (c) => c[1] === `/accounts/${BASE_IDS.accountId}/access/apps/${BASE_IDS.appId}`,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runSetup: covering zone
// ---------------------------------------------------------------------------

describe("runSetup covering zone", () => {
  it("logs the resolved covering zone for subdomain worker/CDN domains", async () => {
    const zones = {
      "3a8r.com": { id: "zone-3a8r", name: "3a8r.com" },
    };
    const deps = makeDeps(makeRunResponder(BASE_IDS, { zones }));
    await runSetup(
      baseOptions({
        workerDomain: "n.3a8r.com",
        cdnDomain: "cdn.n.3a8r.com",
        accessTeamDomain: "team.cloudflareaccess.com",
      }),
      deps,
    );
    expect(deps._calls.logs.some((m) => m.includes("Resolved zone for n.3a8r.com: 3a8r.com"))).toBe(
      true,
    );
    expect(
      deps._calls.logs.some((m) => m.includes("Resolved zone for cdn.n.3a8r.com: 3a8r.com")),
    ).toBe(true);
    const wranglerCommands = deps.wrangler.mock.calls.map((c) => c[0].join(" "));
    expect(wranglerCommands).toContain("deploy");
  });

  it("logs a clear error and returns (no throw, no deploy) when no covering zone exists", async () => {
    const deps = makeDeps(makeRunResponder(BASE_IDS, { zones: {} }));
    await runSetup(
      baseOptions({ workerDomain: "n.3a8r.com", accessTeamDomain: "team.cloudflareaccess.com" }),
      deps,
    );
    expect(deps._calls.logs.some((m) => m.includes("n.3a8r.com") && m.includes("not found"))).toBe(
      true,
    );
    const deployCalls = deps.wrangler.mock.calls.filter((c) => c[0].includes("deploy"));
    expect(deployCalls).toHaveLength(0);
    expect(deps._calls.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runSetup: R2 / D1 error surfacing
// ---------------------------------------------------------------------------

describe("runSetup R2 / D1 error surfacing", () => {
  it("throws the actionable R2 message when listing buckets returns code 10042", async () => {
    const base = makeRunResponder(BASE_IDS);
    const deps = makeDeps(
      overrideApi(
        base,
        (m, p) => m === "GET" && p === `/accounts/${BASE_IDS.accountId}/r2/buckets`,
        async () =>
          err(400, [
            { code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." },
          ]),
      ),
    );
    await expect(
      runSetup(baseOptions({ accessTeamDomain: "team.cloudflareaccess.com" }), deps),
    ).rejects.toThrow(
      "R2 is not enabled on this Cloudflare account. Enable it in the Cloudflare dashboard (R2 > Overview), then re-run.",
    );
  });

  it("throws the actionable R2 message when creating a bucket returns code 10042", async () => {
    const base = makeRunResponder(BASE_IDS);
    const deps = makeDeps(
      overrideApi(
        base,
        (m, p) => m === "POST" && p === `/accounts/${BASE_IDS.accountId}/r2/buckets`,
        async () =>
          err(400, [
            { code: 10042, message: "Please enable R2 through the Cloudflare Dashboard." },
          ]),
      ),
    );
    await expect(
      runSetup(baseOptions({ accessTeamDomain: "team.cloudflareaccess.com" }), deps),
    ).rejects.toThrow(
      "R2 is not enabled on this Cloudflare account. Enable it in the Cloudflare dashboard (R2 > Overview), then re-run.",
    );
  });

  it("throws the actionable D1 message when listing databases returns code 10000", async () => {
    const base = makeRunResponder(BASE_IDS);
    const deps = makeDeps(
      overrideApi(
        base,
        (m, p) => m === "GET" && p === `/accounts/${BASE_IDS.accountId}/d1/database`,
        async () => err(400, [{ code: 10000, message: "Authentication error" }]),
      ),
    );
    await expect(
      runSetup(baseOptions({ accessTeamDomain: "team.cloudflareaccess.com" }), deps),
    ).rejects.toThrow(
      "The Cloudflare API token is missing the D1 permission. Add Account → D1: Edit (see docs/operations/README.md 'API token scopes'), then re-run.",
    );
  });

  it("throws the actionable D1 message when creating a database returns code 10000", async () => {
    const base = makeRunResponder(BASE_IDS);
    const deps = makeDeps(
      overrideApi(
        base,
        (m, p) => m === "POST" && p === `/accounts/${BASE_IDS.accountId}/d1/database`,
        async () => err(400, [{ code: 10000, message: "Authentication error" }]),
      ),
    );
    await expect(
      runSetup(baseOptions({ accessTeamDomain: "team.cloudflareaccess.com" }), deps),
    ).rejects.toThrow(
      "The Cloudflare API token is missing the D1 permission. Add Account → D1: Edit (see docs/operations/README.md 'API token scopes'), then re-run.",
    );
  });
});
