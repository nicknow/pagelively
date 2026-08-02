import { describe, expect, it, vi, type Mock } from "vitest";
import {
  findCoveringZone,
  normalizeDomain,
  provisioningError,
  resolveTeamDomain,
  runSetup,
  zoneCandidates,
} from "../setup.mjs";

// Validator-added edge/regression tests for the S22 setup.mjs provisioning
// field fix (2026-08-01), adjusted for the validator-fix round (2026-08-01,
// second pass). Covers behaviors the slice's 34 tests did not:
//   - org endpoint `result` returned as an ARRAY (real API returns a single
//     object; array shape must not crash)
//   - org endpoint non-JSON body (json() throws) must not crash
//   - SETUP_ACCESS_TEAM_DOMAIN with trailing whitespace is trimmed; a
//     whitespace-only value falls through to org/prompt
//   - the org response field name: the official API schema names the team
//     domain field `auth_domain` (docs example "test.cloudflareaccess.com"),
//     while live accounts may return `domain`. setup.mjs reads
//     `result.domain ?? result.auth_domain` (both shapes resolve; a body with
//     BOTH fields prefers `domain`).
//   - trailing-dot domains: normalizeDomain strips trailing dots and
//     zoneCandidates skips empty candidates, so `/zones?name=` is never called
//     with a blank name and a strict API cannot 400 a trailing-dot input
//   - runSetup: CDN zone missing while the worker zone resolves (the
//     `!cdnZone` log-and-return branch was uncovered)
//   - interactive prompt answer containing a scheme/path is stored verbatim
//     (trimmed only, no normalization)
// All Cloudflare calls are mocked; nothing here touches the real API.

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

function ok(body: Record<string, unknown>): ApiResponse {
  return { ok: true, status: 200, json: async () => ({ success: true, ...body }) };
}

function err(status: number, errors: unknown[]): ApiResponse {
  return { ok: false, status, json: async () => ({ success: false, errors }) };
}

// --- resolveTeamDomain edge shapes -----------------------------------------

describe("resolveTeamDomain: org response shape edge cases (validator)", () => {
  const noopPrompt = vi.fn(async () => "");

  it("org `result` as an ARRAY (not the documented single object) falls through to the prompt", async () => {
    const api = vi.fn<ApiCaller>(async () =>
      ok({ result: [{ domain: "arr.cloudflareaccess.com" }] }),
    );
    const prompt = vi.fn(async () => "prompted.cloudflareaccess.com");
    const result = await resolveTeamDomain({ accountId: "acc-1", api, prompt });
    expect(result).toBe("prompted.cloudflareaccess.com");
    // The array shape must be treated as "no domain known", never as a crash.
    expect(api).toHaveBeenCalledTimes(1);
  });

  it("org non-JSON body (json() throws) falls through to the prompt", async () => {
    const api = vi.fn<ApiCaller>(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("no body");
      },
    }));
    const prompt = vi.fn(async () => "prompted.cloudflareaccess.com");
    const result = await resolveTeamDomain({ accountId: "acc-1", api, prompt });
    expect(result).toBe("prompted.cloudflareaccess.com");
  });

  it("api() itself throwing is swallowed and falls through to the prompt", async () => {
    const api = vi.fn<ApiCaller>(async () => {
      throw new Error("network down");
    });
    const prompt = vi.fn(async () => "prompted.cloudflareaccess.com");
    const result = await resolveTeamDomain({ accountId: "acc-1", api, prompt });
    expect(result).toBe("prompted.cloudflareaccess.com");
  });

  it("SETUP_ACCESS_TEAM_DOMAIN with surrounding whitespace is trimmed", async () => {
    const api = vi.fn<ApiCaller>();
    const result = await resolveTeamDomain({
      env: { SETUP_ACCESS_TEAM_DOMAIN: "  team.cloudflareaccess.com  " },
      api,
      prompt: noopPrompt,
    });
    expect(result).toBe("team.cloudflareaccess.com");
    expect(api).not.toHaveBeenCalled();
  });

  it("whitespace-only SETUP_ACCESS_TEAM_DOMAIN is ignored (falls through to org/prompt)", async () => {
    const api = vi.fn<ApiCaller>(async () => ORG_OK("org.cloudflareaccess.com"));
    const result = await resolveTeamDomain({
      env: { SETUP_ACCESS_TEAM_DOMAIN: "   " },
      accountId: "acc-1",
      api,
      prompt: noopPrompt,
    });
    expect(result).toBe("org.cloudflareaccess.com");
  });

  // FIX ROUND (validator finding, severity HIGH-ish): the current official API
  // schema for GET .../access/organizations documents `result.auth_domain`
  // ("The unique subdomain assigned to your Zero Trust organization") and the
  // PUT example uses `"auth_domain": "your-team-name.cloudflareaccess.com"`;
  // `domain` is not in the schema, though it IS what the human's live account
  // returns. setup.mjs reads `result.domain ?? result.auth_domain`, so a fresh
  // account returning ONLY the documented `auth_domain` shape still resolves
  // automatically (no prompt fall-through).
  it("org body with ONLY the documented `auth_domain` field resolves to the team domain (no prompt)", async () => {
    const api = vi.fn<ApiCaller>(async () =>
      ok({ result: { auth_domain: "team.cloudflareaccess.com" } }),
    );
    const prompt = vi.fn(async () => "prompted.cloudflareaccess.com");
    const result = await resolveTeamDomain({ accountId: "acc-1", api, prompt });
    expect(result).toBe("team.cloudflareaccess.com");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("org body with BOTH `domain` and `auth_domain` prefers `domain` (documented precedence)", async () => {
    const api = vi.fn<ApiCaller>(async () =>
      ok({
        result: { domain: "domain.cloudflareaccess.com", auth_domain: "auth.cloudflareaccess.com" },
      }),
    );
    const prompt = vi.fn(async () => "prompted.cloudflareaccess.com");
    const result = await resolveTeamDomain({ accountId: "acc-1", api, prompt });
    expect(result).toBe("domain.cloudflareaccess.com");
    expect(prompt).not.toHaveBeenCalled();
  });
});

function ORG_OK(domain: string): ApiResponse {
  return ok({ result: { domain } });
}

// --- zone candidates: trailing dot ------------------------------------------

describe("zoneCandidates / findCoveringZone trailing-dot input (validator)", () => {
  it('normalizeDomain strips trailing dots ("example.com." -> "example.com")', () => {
    expect(normalizeDomain("example.com.")).toBe("example.com");
    expect(normalizeDomain("https://Example.COM./")).toBe("example.com");
  });

  it("a trailing dot yields dotless candidates with NO empty-string candidate", () => {
    // FIX ROUND: normalizeDomain now strips trailing dots, and zoneCandidates
    // skips any empty/falsy candidate as defense in depth — so `/zones?name=`
    // can never receive a blank name, which a strict API would reject with 400
    // (previously the empty candidate made findCoveringZone THROW instead of
    // the graceful not-found log).
    const candidates = zoneCandidates("cdn.n.3a8r.com.");
    expect(candidates).toEqual(["cdn.n.3a8r.com", "n.3a8r.com", "3a8r.com", "com"]);
    expect(candidates).not.toContain("");
  });

  it("trailing-dot domain with no covering zone: returns undefined (graceful, no empty-name query)", async () => {
    // All candidates are dotless exact names; the API answers ok-empty for
    // each, so the result is a graceful undefined (no throw) and the empty
    // candidate never reaches the API.
    const api = vi.fn<ApiCaller>(async (_m, p) => {
      const name = new URLSearchParams(p.split("?")[1]).get("name");
      expect(name).not.toBe("");
      return ok({ result: [] });
    });
    const zone = await findCoveringZone("cdn.n.3a8r.com.", api);
    expect(zone).toBeUndefined();
  });

  it("trailing-dot domain resolves the covering zone gracefully even against an API that 400s a blank name", async () => {
    // FIX ROUND: previously the trailing dot survived normalizeDomain, the
    // empty candidate was queried as `/zones?name=`, and a strict API's 400
    // made findCoveringZone THROW. Now the dot is stripped and the empty
    // candidate skipped, so the covering zone resolves with no throw and the
    // 400 branch is never reached.
    const api = vi.fn<ApiCaller>(async (_m, p) => {
      const name = new URLSearchParams(p.split("?")[1]).get("name");
      if (name === "") return err(400, [{ code: 1003, message: "invalid filter" }]);
      if (name === "3a8r.com") return ok({ result: [{ id: "zone-3a8r", name: "3a8r.com" }] });
      return ok({ result: [] });
    });
    const zone = await findCoveringZone("n.3a8r.com.", api);
    expect(zone).toEqual({ id: "zone-3a8r", name: "3a8r.com" });
    // Every query carried a non-empty name; the blank-name branch never fired.
    const names = api.mock.calls.map((c) =>
      new URLSearchParams(String(c[1]).split("?")[1]).get("name"),
    );
    expect(names).toEqual(["n.3a8r.com", "3a8r.com"]);
  });

  it("findCoveringZone('example.com.', api) returns the zone without ever being called with an empty name", async () => {
    const api = vi.fn<ApiCaller>(async (_m, p) => {
      const name = new URLSearchParams(p.split("?")[1]).get("name");
      expect(name).toBe("example.com");
      return ok({ result: [{ id: "zone-ex", name: "example.com" }] });
    });
    const zone = await findCoveringZone("example.com.", api);
    expect(zone).toEqual({ id: "zone-ex", name: "example.com" });
    expect(api).toHaveBeenCalledTimes(1);
  });
});

// --- provisioningError: non-array errors body -------------------------------

describe("provisioningError defensive shapes (validator)", () => {
  it("errors as a non-array (object) falls back to the generic message", async () => {
    const message = await provisioningError(
      { status: 400, json: async () => ({ success: false, errors: { code: 10042 } }) },
      "Failed to list R2 buckets",
      [10042],
    );
    expect(message).toBe("Failed to list R2 buckets (HTTP 400)");
  });
});

// --- runSetup: CDN zone missing while worker zone resolves ------------------

interface Deps {
  fs: {
    readFile: (path: string, encoding?: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
  };
  wrangler: Mock<(args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>>;
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

[vars]
ASSET_BASE_URL = "https://cdn.example.com"
ACCESS_TEAM_DOMAIN = "yourteam.cloudflareaccess.com"
ACCESS_AUD = "00000000000000000000000000000000000000000000000000"
`;

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
      return await apiImpl(...(args as [string, string, unknown, unknown]));
    }),
    wrangler: vi.fn(async (...args: unknown[]) => {
      calls.wrangler.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
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

const IDS = {
  accountId: "acc-123",
  appId: "app-123",
  aud: "aud-123",
  dbId: "d1-123",
  bucketName: "pagelively-assets",
  workerZoneId: "zone-worker-123",
  cdnZoneId: "zone-cdn-123",
};

function makeRunResponder(zones: Record<string, { id: string; name: string }>): ApiCaller {
  return async (method: string, path: string) => {
    if (method === "GET" && path === `/accounts/${IDS.accountId}/access/apps`)
      return ok({
        result: [
          {
            id: IDS.appId,
            aud: IDS.aud,
            name: "Pagelively Admin",
            domain: "n.3a8r.com/admin",
            destinations: [
              { type: "public", uri: "n.3a8r.com/admin" },
              { type: "public", uri: "n.3a8r.com/api" },
            ],
            type: "self_hosted",
          },
        ],
      });
    if (method === "GET" && path === `/accounts/${IDS.accountId}/access/organizations`)
      return ok({ result: { domain: "team.cloudflareaccess.com" } });
    if (method === "GET" && path === `/accounts/${IDS.accountId}/access/apps/${IDS.appId}/policies`)
      return ok({ result: [] });
    if (
      method === "POST" &&
      path === `/accounts/${IDS.accountId}/access/apps/${IDS.appId}/policies`
    )
      return ok({ result: { id: "policy-1" } });
    if (method === "GET" && path.startsWith("/zones")) {
      const name = new URLSearchParams(path.split("?")[1]).get("name") || "";
      const zone = zones[name];
      return ok({ result: zone ? [zone] : [] });
    }
    if (method === "GET" && path === `/accounts/${IDS.accountId}/r2/buckets`)
      return ok({ result: { buckets: [] } });
    if (method === "POST" && path === `/accounts/${IDS.accountId}/r2/buckets`)
      return ok({ result: { name: IDS.bucketName } });
    if (method === "POST" && path.includes("/domains/custom"))
      return ok({ result: { domain: "cdn.pages.example.com", status: "active" } });
    if (method === "GET" && path === `/accounts/${IDS.accountId}/d1/database`)
      return ok({ result: [] });
    if (method === "POST" && path === `/accounts/${IDS.accountId}/d1/database`)
      return ok({ result: { uuid: IDS.dbId, name: "pagelively-db" } });
    if (method === "GET" && path === `/accounts/${IDS.accountId}/storage/kv/namespaces`)
      return ok({ result: [] });
    throw new Error(`unexpected API call: ${method} ${path}`);
  };
}

function baseOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: IDS.accountId,
    apiToken: "token-123",
    workerDomain: "n.3a8r.com",
    cdnDomain: "cdn.n.3a8r.com",
    projectName: "pagelively",
    adminEmails: "admin@example.com",
    createKv: false,
    accessTeamDomain: "team.cloudflareaccess.com",
    ...extra,
  };
}

describe("runSetup: CDN zone missing while worker zone resolves (validator)", () => {
  it("logs the CDN-domain error and returns without deploying or writing wrangler.toml", async () => {
    // Worker domain n.3a8r.com is covered by the 3a8r.com zone; the CDN domain
    // cdn.example.org has no covering zone in the account.
    const zones = { "3a8r.com": { id: "zone-3a8r", name: "3a8r.com" } };
    const deps = makeDeps(makeRunResponder(zones));
    await runSetup(baseOptions({ cdnDomain: "cdn.example.org" }), deps);

    // Worker zone resolved, CDN zone not -> the !cdnZone branch must fire.
    expect(deps._calls.logs.some((m) => m.includes("Resolved zone for n.3a8r.com"))).toBe(true);
    expect(
      deps._calls.logs.some(
        (m) => m.includes("cdn.example.org") && m.includes("not found in this Cloudflare account"),
      ),
    ).toBe(true);
    expect(deps._calls.logs.some((m) => m.includes("Resolved zone for cdn.example.org"))).toBe(
      false,
    );

    // No deploy, no wrangler.toml write, no R2/D1 provisioning beyond zone step.
    const deployCalls = deps.wrangler.mock.calls.filter((c) => c[0].includes("deploy"));
    expect(deployCalls).toHaveLength(0);
    expect(deps._calls.writes).toHaveLength(0);
    expect(deps.api.mock.calls.some((c) => c[1].includes("/r2/buckets"))).toBe(false);
  });
});

// --- prompt answer with a scheme/path ---------------------------------------

describe("resolveTeamDomain: prompt answer with scheme/path (validator)", () => {
  it("is stored verbatim (trimmed only, no normalization) — documents current behavior", async () => {
    const api = vi.fn<ApiCaller>(async () => ok({ result: {} }));
    const prompt = vi.fn(async () => "  https://team.cloudflareaccess.com/admin  ");
    const result = await resolveTeamDomain({ accountId: "acc-1", api, prompt });
    // Trimmed, but the scheme and path are NOT stripped: the value is written
    // into wrangler.toml as-is. Access expects the bare team domain; a pasted
    // URL would break auth at runtime. No spec requirement to normalize today;
    // flagged as a possible follow-up.
    expect(result).toBe("https://team.cloudflareaccess.com/admin");
  });
});
