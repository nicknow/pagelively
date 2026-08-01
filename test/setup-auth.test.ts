import { describe, expect, it, vi } from "vitest";
import {
  createApiClient,
  describeApiError,
  findEncryptedWranglerConfig,
  parseOauthToken,
  resolveWranglerAuthToken,
  runSetup,
  wranglerConfigPaths,
} from "../setup.mjs";

// Field-fix tests for the setup.mjs OAuth fallback auth bug:
//   - wranglerConfigPaths / parseOauthToken / resolveWranglerAuthToken locate the
//     plaintext OAuth token written by `wrangler login`.
//   - createApiClient sends Bearer from CLOUDFLARE_API_TOKEN, else the OAuth
//     fallback, else a clear error.
//   - describeApiError surfaces the Cloudflare API errors[] body.
//   - runSetup-level integration with the real api client (mocked fetch only —
//     no real Cloudflare calls).

// ---------------------------------------------------------------------------
// wranglerConfigPaths
// ---------------------------------------------------------------------------

describe("wranglerConfigPaths", () => {
  // Candidate order mirrors real wrangler (v4.116) global config resolution:
  //   getGlobalConfigPath() = xdgAppPaths(".wrangler").config() + "config/default.toml"
  // with xdg-portable's XDG.config() per platform and the legacy ~/.wrangler
  // dir override. WRANGLER_HOME is NOT a wrangler variable (0 hits in the
  // v4.116 bundle) and is deliberately absent here.

  it("adds $XDG_CONFIG_HOME/.wrangler/config/default.toml first when XDG_CONFIG_HOME is set", () => {
    const paths = wranglerConfigPaths({ XDG_CONFIG_HOME: "/xdg" }, { homedir: () => "/home/u" });
    expect(paths[0]).toBe("/xdg/.wrangler/config/default.toml");
  });

  it("orders Linux candidates: XDG_CONFIG_HOME, ~/.config/.wrangler, then legacy ~/.wrangler", () => {
    const paths = wranglerConfigPaths({ XDG_CONFIG_HOME: "/xdg" }, { homedir: () => "/home/nick" });
    expect(paths).toEqual([
      "/xdg/.wrangler/config/default.toml",
      "/home/nick/.config/.wrangler/config/default.toml",
      "/home/nick/.wrangler/config/default.toml",
    ]);
  });

  it("lists the native macOS path (~/Library/Preferences) before the legacy ~/.wrangler path", () => {
    const paths = wranglerConfigPaths(
      {},
      { homedir: () => "/Users/nick", platform: () => "darwin" },
    );
    expect(paths).toEqual([
      "/Users/nick/Library/Preferences/.wrangler/config/default.toml",
      "/Users/nick/.wrangler/config/default.toml",
    ]);
  });

  it("honors XDG_CONFIG_HOME before the macOS native path", () => {
    const paths = wranglerConfigPaths(
      { XDG_CONFIG_HOME: "/xdg" },
      { homedir: () => "/Users/nick", platform: () => "darwin" },
    );
    expect(paths).toEqual([
      "/xdg/.wrangler/config/default.toml",
      "/Users/nick/Library/Preferences/.wrangler/config/default.toml",
      "/Users/nick/.wrangler/config/default.toml",
    ]);
  });

  it("uses %APPDATA%\\xdg.config\\.wrangler first and the legacy ~\\.wrangler on Windows (backslash separators)", () => {
    const paths = wranglerConfigPaths(
      { APPDATA: "C:\\Users\\nick\\AppData\\Roaming" },
      { homedir: () => "C:\\Users\\nick", platform: () => "win32" },
    );
    expect(paths).toEqual([
      "C:\\Users\\nick\\AppData\\Roaming\\xdg.config\\.wrangler\\config\\default.toml",
      "C:\\Users\\nick\\.wrangler\\config\\default.toml",
    ]);
  });

  it("falls back to ~\\AppData\\Roaming for the Windows native path when APPDATA is unset", () => {
    const paths = wranglerConfigPaths(
      {},
      { homedir: () => "C:\\Users\\nick", platform: () => "win32" },
    );
    expect(paths).toEqual([
      "C:\\Users\\nick\\AppData\\Roaming\\xdg.config\\.wrangler\\config\\default.toml",
      "C:\\Users\\nick\\.wrangler\\config\\default.toml",
    ]);
  });

  it("honors XDG_CONFIG_HOME before the Windows native path", () => {
    const paths = wranglerConfigPaths(
      { XDG_CONFIG_HOME: "D:\\xdg" },
      { homedir: () => "C:\\Users\\nick", platform: () => "win32" },
    );
    expect(paths).toEqual([
      "D:\\xdg\\.wrangler\\config\\default.toml",
      "C:\\Users\\nick\\AppData\\Roaming\\xdg.config\\.wrangler\\config\\default.toml",
      "C:\\Users\\nick\\.wrangler\\config\\default.toml",
    ]);
  });

  it("uses the injected homedir for the ~ candidates (HOME case)", () => {
    const paths = wranglerConfigPaths({}, { homedir: () => "/home/nick" });
    expect(paths).toContain("/home/nick/.config/.wrangler/config/default.toml");
    expect(paths).toContain("/home/nick/.wrangler/config/default.toml");
  });

  it("falls back to env.HOME when no homedir function is injected", () => {
    const paths = wranglerConfigPaths({ HOME: "/home/fallback" });
    expect(paths).toEqual([
      "/home/fallback/.config/.wrangler/config/default.toml",
      "/home/fallback/.wrangler/config/default.toml",
    ]);
  });

  it("dedupes identical candidates", () => {
    const paths = wranglerConfigPaths(
      { XDG_CONFIG_HOME: "/home/nick/.config" },
      { homedir: () => "/home/nick" },
    );
    expect(new Set(paths).size).toBe(paths.length);
    expect(
      paths.filter((p) => p === "/home/nick/.config/.wrangler/config/default.toml"),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parseOauthToken
// ---------------------------------------------------------------------------

describe("parseOauthToken", () => {
  it("extracts a double-quoted oauth_token value", () => {
    const toml = 'oauth_token = "tok-123"\nrefresh_token = "refresh-1"\nscopes = ["account:read"]';
    expect(parseOauthToken(toml)).toBe("tok-123");
  });

  it("tolerates whitespace around the equals sign", () => {
    expect(parseOauthToken('oauth_token="tok-1"')).toBe("tok-1");
    expect(parseOauthToken('oauth_token   =   "tok-2"')).toBe("tok-2");
  });

  it("returns undefined for garbage content", () => {
    expect(parseOauthToken("oauth_token = tok-123")).toBeUndefined();
    expect(parseOauthToken('oauth_token: "tok-123"')).toBeUndefined();
    expect(parseOauthToken('refresh_token = "tok-123"')).toBeUndefined();
    expect(parseOauthToken('OAUTH_TOKEN = "tok-123"')).toBeUndefined();
  });

  it("returns undefined for missing or empty input", () => {
    expect(parseOauthToken("")).toBeUndefined();
    expect(parseOauthToken("no token here")).toBeUndefined();
    expect(parseOauthToken(undefined)).toBeUndefined();
    expect(parseOauthToken(null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resolveWranglerAuthToken
// ---------------------------------------------------------------------------

describe("resolveWranglerAuthToken", () => {
  const enoent = () => Object.assign(new Error("no such file"), { code: "ENOENT" });

  it("returns the token from the first readable matching path", async () => {
    const readFile = vi.fn(async (p: string) =>
      p === "/a/config/default.toml" ? 'oauth_token = "tok-a"' : 'oauth_token = "tok-b"',
    );
    const result = await resolveWranglerAuthToken(
      ["/a/config/default.toml", "/b/config/default.toml"],
      readFile,
    );
    expect(result).toEqual({ token: "tok-a", path: "/a/config/default.toml" });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("skips ENOENT paths and keeps looking", async () => {
    const readFile = vi.fn(async (p: string) => {
      if (p === "/a/config/default.toml") throw enoent();
      return 'oauth_token = "tok-b"';
    });
    const result = await resolveWranglerAuthToken(
      ["/a/config/default.toml", "/b/config/default.toml"],
      readFile,
    );
    expect(result).toEqual({ token: "tok-b", path: "/b/config/default.toml" });
  });

  it("keeps looking when a readable file has no oauth_token", async () => {
    const readFile = vi.fn(async (p: string) =>
      p === "/a/config/default.toml" ? 'refresh_token = "x"' : 'oauth_token = "tok-b"',
    );
    const result = await resolveWranglerAuthToken(
      ["/a/config/default.toml", "/b/config/default.toml"],
      readFile,
    );
    expect(result).toEqual({ token: "tok-b", path: "/b/config/default.toml" });
  });

  it("returns undefined token/path when nothing is readable", async () => {
    const readFile = vi.fn(async () => {
      throw enoent();
    });
    const result = await resolveWranglerAuthToken(["/a/config/default.toml"], readFile);
    expect(result).toEqual({ token: undefined, path: undefined });
  });

  it("propagates non-ENOENT read errors", async () => {
    const readFile = vi.fn(async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    await expect(resolveWranglerAuthToken(["/a/config/default.toml"], readFile)).rejects.toThrow(
      "EACCES",
    );
  });
});

// ---------------------------------------------------------------------------
// findEncryptedWranglerConfig
// ---------------------------------------------------------------------------

describe("findEncryptedWranglerConfig", () => {
  const enoent = () => Object.assign(new Error("no such file"), { code: "ENOENT" });

  it("returns the first default.enc that exists (alongside a candidate default.toml)", async () => {
    const stat = vi.fn(async (p: string) => {
      if (p === "/a/config/default.enc") throw enoent();
      return {};
    });
    expect(
      await findEncryptedWranglerConfig(["/a/config/default.toml", "/b/config/default.toml"], stat),
    ).toBe("/b/config/default.enc");
  });

  it("returns undefined when no default.enc exists", async () => {
    const stat = vi.fn(async () => {
      throw enoent();
    });
    expect(await findEncryptedWranglerConfig(["/a/config/default.toml"], stat)).toBeUndefined();
  });

  it("propagates non-ENOENT stat errors", async () => {
    const stat = vi.fn(async () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    await expect(findEncryptedWranglerConfig(["/a/config/default.toml"], stat)).rejects.toThrow(
      "EACCES",
    );
  });
});

// ---------------------------------------------------------------------------
// createApiClient (the api() Bearer behavior)
// ---------------------------------------------------------------------------

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

type FetchImpl = (
  url: string,
  init?: FetchInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<Record<string, unknown>> }>;

const okResponse = (data: Record<string, unknown> = { success: true }) =>
  ({ ok: true, status: 200, json: async () => data }) as const;

describe("createApiClient", () => {
  it("sends Authorization: Bearer <env token> from CLOUDFLARE_API_TOKEN", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => okResponse());
    const api = createApiClient({ env: { CLOUDFLARE_API_TOKEN: "env-tok" }, fetchImpl });
    const res = await api("GET", "/accounts/acc/access/apps");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/access/apps");
    expect(init?.headers?.Authorization).toBe("Bearer env-tok");
    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(await res.json()).toEqual({ success: true });
  });

  it("falls back to the OAuth token when no env token is set", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => okResponse());
    const api = createApiClient({ env: {}, oauthToken: "oauth-tok", fetchImpl });
    await api("GET", "/accounts/acc/access/apps");
    expect(fetchImpl.mock.calls[0][1]?.headers?.Authorization).toBe("Bearer oauth-tok");
  });

  it("prefers the env token over an OAuth token", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => okResponse());
    const api = createApiClient({
      env: { CLOUDFLARE_API_TOKEN: "env-tok" },
      oauthToken: "oauth-tok",
      fetchImpl,
    });
    await api("GET", "/x");
    expect(fetchImpl.mock.calls[0][1]?.headers?.Authorization).toBe("Bearer env-tok");
  });

  it("resolves the OAuth token lazily when none was known up front", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => okResponse());
    const resolveOauthToken = vi.fn(async () => ({ token: "lazy-tok", path: "/p" }));
    const api = createApiClient({ env: {}, resolveOauthToken, fetchImpl });
    await api("GET", "/x");
    expect(resolveOauthToken).toHaveBeenCalled();
    expect(fetchImpl.mock.calls[0][1]?.headers?.Authorization).toBe("Bearer lazy-tok");
  });

  it("throws a clear error when no credentials are available at all", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => okResponse());
    const api = createApiClient({ env: {}, fetchImpl });
    await expect(api("GET", "/x")).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
    await expect(api("GET", "/x")).rejects.toThrow(/wrangler login/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces the keyring-encrypted credential error from a lazy OAuth resolver", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => okResponse());
    const api = createApiClient({
      env: {},
      resolveOauthToken: async () => {
        throw new Error(
          "Found an encrypted wrangler OAuth credential at /home/u/.config/.wrangler/config/" +
            "default.enc, which this script cannot read. Re-run `wrangler login --no-use-keyring` " +
            "to store the token as plaintext, or set CLOUDFLARE_API_TOKEN and re-run setup.",
        );
      },
      fetchImpl,
    });
    await expect(api("GET", "/x")).rejects.toThrow(/wrangler login --no-use-keyring/);
    await expect(api("GET", "/x")).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("serializes the request body as JSON", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => okResponse());
    const api = createApiClient({ env: { CLOUDFLARE_API_TOKEN: "t" }, fetchImpl });
    await api("POST", "/accounts/a/access/apps", { name: "x" });
    expect(fetchImpl.mock.calls[0][1]?.body).toBe(JSON.stringify({ name: "x" }));
  });
});

// ---------------------------------------------------------------------------
// describeApiError
// ---------------------------------------------------------------------------

describe("describeApiError", () => {
  it("includes errors[].code and errors[].message plus the status", async () => {
    const message = await describeApiError(
      {
        status: 400,
        json: async () => ({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        }),
      },
      "Failed to list Access apps",
    );
    expect(message).toContain("400");
    expect(message).toContain("10000");
    expect(message).toContain("Authentication error");
    expect(message).toContain("Failed to list Access apps");
  });

  it("falls back to status-only when the body has no errors array", async () => {
    const message = await describeApiError(
      { status: 500, json: async () => ({ success: false }) },
      "Failed",
    );
    expect(message).toBe("Failed (HTTP 500)");
  });

  it("tolerates an already-consumed response body", async () => {
    const message = await describeApiError(
      {
        status: 403,
        json: async () => {
          throw new Error("body already consumed");
        },
      },
      "Failed",
    );
    expect(message).toBe("Failed (HTTP 403)");
  });
});

// ---------------------------------------------------------------------------
// runSetup-level integration with the real api client
// ---------------------------------------------------------------------------

const PLACEHOLDER_WRANGLER_TOML = `name = "pagelively"
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

type SetupOptions = {
  accountId: string;
  workerDomain: string;
  cdnDomain: string;
  projectName: string;
  accessTeamDomain: string;
  adminEmails: string;
  apiToken?: string;
  createKv?: boolean;
};

interface TestDeps {
  fs: {
    readFile: (path: string, encoding?: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
  };
  wrangler: (args: string[]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  api: (
    method: string,
    path: string,
    body?: unknown,
    opts?: unknown,
  ) => Promise<{ ok: boolean; status: number; json: () => Promise<Record<string, unknown>> }>;
  prompt: (message: string, defaultValue?: string) => Promise<string>;
  confirm: (message: string, defaultValue?: boolean) => Promise<boolean>;
  log: (message: string) => void;
  pause: (message: string) => Promise<void>;
  env?: Record<string, string>;
}

function makeDeps(overrides: Partial<TestDeps> = {}): TestDeps {
  const defaults: TestDeps = {
    fs: {
      readFile: vi.fn(async () => PLACEHOLDER_WRANGLER_TOML),
      writeFile: vi.fn(async () => {}),
    },
    wrangler: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    api: vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: [] }),
    })),
    prompt: vi.fn(async (_message: string, defaultValue?: string) => defaultValue ?? ""),
    confirm: vi.fn(async () => true),
    log: vi.fn(),
    pause: vi.fn(async () => {}),
  };
  return { ...defaults, ...overrides };
}

interface ResponderIds {
  accountId: string;
  appId: string;
  aud: string;
  bucketName: string;
  dbId: string;
  workerZoneId: string;
  cdnZoneId: string;
}

function fullFetchResponder(ids: ResponderIds): FetchImpl {
  return async (url: string, init: FetchInit = {}) => {
    const method = init.method || "GET";
    const u = new URL(url);
    const p = u.pathname.replace(/^\/client\/v4/, "");
    const respond = (ok: boolean, status: number, data: Record<string, unknown>) => ({
      ok,
      status,
      json: async () => data,
    });

    if (method === "GET" && p === `/accounts/${ids.accountId}/access/apps`)
      return respond(true, 200, { success: true, result: [] });
    if (method === "POST" && p === `/accounts/${ids.accountId}/access/apps`)
      return respond(true, 200, {
        success: true,
        result: { id: ids.appId, aud: ids.aud, name: "Pagelively Admin" },
      });
    if (method === "GET" && p === `/accounts/${ids.accountId}/access/apps/${ids.appId}/policies`)
      return respond(true, 200, { success: true, result: [] });
    if (method === "POST" && p === `/accounts/${ids.accountId}/access/apps/${ids.appId}/policies`)
      return respond(true, 200, { success: true, result: { id: "policy-1" } });
    if (method === "GET" && p.startsWith("/zones")) {
      const name = u.searchParams.get("name") || "";
      return respond(true, 200, {
        success: true,
        result: name.includes("cdn.")
          ? [{ id: ids.cdnZoneId, name: "cdn.pages.example.com" }]
          : [{ id: ids.workerZoneId, name: "pages.example.com" }],
      });
    }
    if (method === "GET" && p === `/accounts/${ids.accountId}/r2/buckets`)
      return respond(true, 200, { success: true, result: { buckets: [] } });
    if (method === "POST" && p === `/accounts/${ids.accountId}/r2/buckets`)
      return respond(true, 200, { success: true, result: { name: ids.bucketName } });
    if (
      method === "POST" &&
      p === `/accounts/${ids.accountId}/r2/buckets/${ids.bucketName}/domains/custom`
    )
      return respond(true, 200, {
        success: true,
        result: { domain: "cdn.pages.example.com", status: "active" },
      });
    if (method === "GET" && p === `/accounts/${ids.accountId}/d1/database`)
      return respond(true, 200, { success: true, result: [] });
    if (method === "POST" && p === `/accounts/${ids.accountId}/d1/database`)
      return respond(true, 200, {
        success: true,
        result: { uuid: ids.dbId, name: "pagelively-db" },
      });
    throw new Error(`Unexpected API call: ${method} ${url}`);
  };
}

describe("runSetup with the real api client", () => {
  const captureRejection = async (promise: Promise<void>): Promise<Error | null> =>
    promise.then(
      () => null,
      (e: unknown) => e as Error,
    );
  const ids: ResponderIds = {
    accountId: "acc-123",
    appId: "app-123",
    aud: "aud-123",
    bucketName: "pagelively-assets",
    dbId: "d1-123",
    workerZoneId: "zone-w",
    cdnZoneId: "zone-c",
  };
  const options: SetupOptions = {
    accountId: ids.accountId,
    workerDomain: "pages.example.com",
    cdnDomain: "cdn.pages.example.com",
    projectName: "pagelively",
    accessTeamDomain: "team.cloudflareaccess.com",
    adminEmails: "admin@example.com",
    createKv: false,
  };

  it("sends Bearer <env token> on every API call when CLOUDFLARE_API_TOKEN is set", async () => {
    const seenAuth: string[] = [];
    const recordingFetch: FetchImpl = async (url, init) => {
      seenAuth.push(init?.headers?.Authorization || "");
      return fullFetchResponder(ids)(url, init);
    };
    const deps = makeDeps({
      api: createApiClient({
        env: { CLOUDFLARE_API_TOKEN: "env-tok" },
        fetchImpl: recordingFetch,
      }),
      env: { CLOUDFLARE_API_TOKEN: "env-tok" },
    });
    await runSetup(options, deps);
    expect(seenAuth.length).toBeGreaterThan(0);
    for (const auth of seenAuth) expect(auth).toBe("Bearer env-tok");
  });

  it("sends Bearer <OAuth token> on every API call when only wrangler OAuth credentials exist", async () => {
    const seenAuth: string[] = [];
    const recordingFetch: FetchImpl = async (url, init) => {
      seenAuth.push(init?.headers?.Authorization || "");
      return fullFetchResponder(ids)(url, init);
    };
    const deps = makeDeps({
      api: createApiClient({ env: {}, oauthToken: "oauth-tok", fetchImpl: recordingFetch }),
      env: {},
    });
    await runSetup(options, deps);
    expect(seenAuth.length).toBeGreaterThan(0);
    for (const auth of seenAuth) expect(auth).toBe("Bearer oauth-tok");
  });

  it("throws a clear error when no token or OAuth credentials exist", async () => {
    const deps = makeDeps({
      api: createApiClient({ env: {}, fetchImpl: vi.fn() }),
      env: {},
    });
    const error = await captureRejection(runSetup(options, deps));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/CLOUDFLARE_API_TOKEN/);
    expect((error as Error).message).toMatch(/wrangler login/);
  });

  it("surfaces Cloudflare errors[] on Access apps listing failure (400)", async () => {
    const deps = makeDeps({
      api: vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
        }),
      })),
    });
    const error = await captureRejection(runSetup({ ...options, apiToken: "token-123" }, deps));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Failed to list Access apps");
    expect((error as Error).message).toContain("10000");
    expect((error as Error).message).toContain("Authentication error");
  });

  it("still pauses (not throws) when Access apps returns error code 1047 (Zero Trust not initialized)", async () => {
    const pauses: string[] = [];
    const deps = makeDeps({
      api: vi.fn(async () => ({
        ok: false,
        status: 403,
        json: async () => ({
          success: false,
          errors: [{ code: 1047, message: "Zero Trust not enabled" }],
        }),
      })),
      pause: vi.fn(async (message: string) => {
        pauses.push(message);
      }),
    });
    await runSetup({ ...options, apiToken: "token-123" }, deps);
    expect(pauses.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Validator-added regression coverage (edge cases in the changed code)
// ---------------------------------------------------------------------------

describe("validator regressions: createApiClient / describeApiError edge cases", () => {
  it("throws a clear error when no fetch implementation exists at all", () => {
    vi.stubGlobal("fetch", undefined);
    try {
      expect(() => createApiClient({ env: {} })).toThrow(/No fetch implementation available/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("resolves json() to null (never throws) when the response body is not JSON", async () => {
    const api = createApiClient({
      env: { CLOUDFLARE_API_TOKEN: "t" },
      fetchImpl: async () => ({
        ok: false,
        status: 502,
        json: () => Promise.reject(new Error("Unexpected token '<'")),
      }),
    });
    const res = await api("GET", "/x");
    expect(res.status).toBe(502);
    expect(await res.json()).toBeNull();
  });

  it("re-attempts lazy OAuth resolution when the resolver returns no token", async () => {
    const fetchImpl = vi.fn<FetchImpl>(async () => okResponse());
    let calls = 0;
    const api = createApiClient({
      env: {},
      resolveOauthToken: async () => {
        calls += 1;
        return calls === 1 ? undefined : { token: "second-attempt" };
      },
      fetchImpl,
    });
    await expect(api("GET", "/x")).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
    expect(fetchImpl).not.toHaveBeenCalled();
    await api("GET", "/x");
    expect(fetchImpl.mock.calls[0][1]?.headers?.Authorization).toBe("Bearer second-attempt");
    expect(calls).toBe(2);
  });

  it("surfaces a message-only error entry from describeApiError", async () => {
    const message = await describeApiError(
      { status: 400, json: async () => ({ errors: [{ message: "only a message" }] }) },
      "F",
    );
    expect(message).toBe("F (HTTP 400): only a message");
  });

  it("surfaces the code when an error entry has no message (no crash)", async () => {
    const message = await describeApiError(
      { status: 400, json: async () => ({ errors: [{ code: 10000 }] }) },
      "F",
    );
    expect(message).toContain("F (HTTP 400)");
    expect(message).toContain("[10000]");
  });

  it("returns an empty candidate list when no homedir function and no HOME are available", () => {
    expect(wranglerConfigPaths({})).toEqual([]);
  });

  it("dedupes candidates when XDG_CONFIG_HOME overlaps the platform-native config dir", () => {
    const paths = wranglerConfigPaths(
      { XDG_CONFIG_HOME: "/home/u/.config" },
      { homedir: () => "/home/u" },
    );
    // XDG collides with the Linux native ~/.config/.wrangler candidate; only
    // the legacy ~/.wrangler candidate remains distinct.
    expect(paths).toEqual([
      "/home/u/.config/.wrangler/config/default.toml",
      "/home/u/.wrangler/config/default.toml",
    ]);
  });
});
