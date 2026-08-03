#!/usr/bin/env node
// Human-run provisioning script for Pagelively.
// Cross-platform (Node.js ES module, no shell commands). Unit-tested via
// dependency injection; the exported runSetup() accepts all external seams so
// the test suite can mock Cloudflare API calls, wrangler, the filesystem, and
// user prompts.
//
// Two modes:
//   - Interactive (default): prompts for domains, project name, admin emails,
//     KV choice; falls back to `wrangler login` without an API token.
//   - Headless (SETUP_NON_INTERACTIVE=1, used by .github/workflows/deploy.yml):
//     reads every value from the environment (see envToSetupOptions), never
//     prompts, and fails deterministically (no pause) when something is
//     missing — e.g. no CLOUDFLARE_API_TOKEN, no ADMIN_EMAILS, or Zero Trust
//     not initialized.

export const DEFAULTS = {
  minNodeVersion: 22,
  wranglerToml: "wrangler.toml",
};

// --- Headless (CI / non-interactive) mode -----------------------------------
// GitHub Actions runs `npm run setup` with SETUP_NON_INTERACTIVE=1 and every
// value supplied via env (see .github/workflows/deploy.yml). These helpers map
// the environment into runSetup options and parse the truthy conventions
// (1|true|yes) used by the workflow inputs.

export function parseTruthy(value) {
  if (value === undefined || value === null || value === "") return undefined;
  return ["1", "true", "yes"].includes(String(value).trim().toLowerCase());
}

export function envToSetupOptions(env = {}) {
  const createKv = parseTruthy(env.SETUP_CREATE_KV);
  const options = {
    workerDomain: env.SETUP_WORKER_DOMAIN || undefined,
    cdnDomain: env.SETUP_CDN_DOMAIN || undefined,
    projectName: env.SETUP_PROJECT_NAME || undefined,
    adminEmails: env.ADMIN_EMAILS || undefined,
    headless: parseTruthy(env.SETUP_NON_INTERACTIVE) === true,
  };
  if (createKv !== undefined) options.createKv = createKv;
  if (env.SETUP_ACCESS_TEAM_DOMAIN) options.accessTeamDomain = env.SETUP_ACCESS_TEAM_DOMAIN;
  return options;
}

// Fixed prompt messages -> the env var that supplies the value in headless
// mode, so a missing value fails with a copy-pasteable instruction.
const PROMPT_ENV_OVERRIDES = [
  { match: "Cloudflare account ID", label: "Cloudflare account ID", env: "CLOUDFLARE_ACCOUNT_ID" },
  { match: "Worker domain", label: "worker domain", env: "SETUP_WORKER_DOMAIN" },
  { match: "CDN / asset domain", label: "CDN / asset domain", env: "SETUP_CDN_DOMAIN" },
  { match: "Project name", label: "project name", env: "SETUP_PROJECT_NAME" },
  { match: "Admin email", label: "admin email(s)", env: "ADMIN_EMAILS" },
  {
    match: "Zero Trust team domain",
    label: "Zero Trust team domain",
    env: "SETUP_ACCESS_TEAM_DOMAIN",
  },
];

export function parseAdminEmails(input) {
  if (!input) return [];
  return String(input)
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function normalizeDomain(domain) {
  return String(domain)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/\.+$/, "");
}

export function apexDomain(domain) {
  const parts = normalizeDomain(domain).split(".");
  if (parts.length < 2) return normalizeDomain(domain);
  return parts.slice(-2).join(".");
}

export function sanitizeName(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function deriveBucketName(projectName) {
  return `${sanitizeName(projectName)}-assets`;
}

export function deriveDbName(projectName) {
  return `${sanitizeName(projectName)}-db`;
}

export function deriveKvName(projectName) {
  return `${sanitizeName(projectName)}-kv`;
}

export function updateWranglerToml(content, values) {
  let updated = content;

  if (values.bucketName) {
    updated = updated.replace(
      /bucket_name = "[^"]*"/,
      () => `bucket_name = "${values.bucketName}"`,
    );
  }
  if (values.dbName) {
    updated = updated.replace(
      /database_name = "[^"]*"/,
      () => `database_name = "${values.dbName}"`,
    );
  }
  if (values.dbId) {
    updated = updated.replace(/database_id = "[^"]*"/, () => `database_id = "${values.dbId}"`);
  }
  if (values.assetBaseUrl) {
    updated = updated.replace(
      /ASSET_BASE_URL = "[^"]*"/,
      () => `ASSET_BASE_URL = "${values.assetBaseUrl}"`,
    );
  }
  if (values.accessTeamDomain) {
    updated = updated.replace(
      /ACCESS_TEAM_DOMAIN = "[^"]*"/,
      () => `ACCESS_TEAM_DOMAIN = "${values.accessTeamDomain}"`,
    );
  }
  if (values.accessAud) {
    updated = updated.replace(/ACCESS_AUD = "[^"]*"/, () => `ACCESS_AUD = "${values.accessAud}"`);
  }

  if (values.kvId) {
    const commentedBlock = /#\s*\[\[kv_namespaces\]\]\n#\s*binding = "KV"\n#\s*id = "[^"]*"/;
    if (commentedBlock.test(updated)) {
      updated = updated.replace(
        commentedBlock,
        () => `[[kv_namespaces]]\nbinding = "KV"\nid = "${values.kvId}"`,
      );
    } else if (updated.includes("[[kv_namespaces]]")) {
      updated = updated.replace(/id = "[^"]*"/, () => `id = "${values.kvId}"`);
    } else {
      updated =
        updated.trimEnd() + `\n\n[[kv_namespaces]]\nbinding = "KV"\nid = "${values.kvId}"\n`;
    }
  }

  if (values.workerDomain) {
    const routePattern = `pattern = "${values.workerDomain}"`;
    if (!updated.includes(routePattern)) {
      updated =
        updated.trimEnd() +
        `\n\n# Worker custom domain route (auto-creates DNS on deploy)\n[[routes]]\npattern = "${values.workerDomain}"\ncustom_domain = true\n`;
    }
  }

  return updated;
}

// --- Wrangler OAuth credential fallback -------------------------------------
// Interactive setup has no CLOUDFLARE_API_TOKEN: `wrangler login` stores the
// OAuth credentials it exchanges, and the plaintext token lands in a
// `config/default.toml` under wrangler's global config directory. These pure
// helpers locate and parse that file so API calls can authenticate. `os`
// values are injected (homedir/platform) so the Workers-pool tests never touch
// `node:os` (which is unavailable in workerd) — buildRealDeps passes the real
// ones from a dynamic `import("node:os")`.

export function wranglerConfigPaths(env = {}, osInfo = {}) {
  const windows =
    (osInfo.platform ? osInfo.platform() : undefined) === "win32" ||
    (!osInfo.platform && typeof process !== "undefined" && process.platform === "win32");
  const darwin =
    (osInfo.platform ? osInfo.platform() : undefined) === "darwin" ||
    (!osInfo.platform && typeof process !== "undefined" && process.platform === "darwin");
  const sep = windows ? "\\" : "/";
  const join = (...parts) => parts.join(sep);
  const home = osInfo.homedir ? osInfo.homedir() : env.HOME || "";

  const candidates = [];
  // XDG_CONFIG_HOME, when set, overrides the platform config dir on every OS
  // (xdg-portable XDG.config(): valOrPath(env XDG_CONFIG_HOME, default)).
  if (env.XDG_CONFIG_HOME) {
    candidates.push(join(env.XDG_CONFIG_HOME, ".wrangler", "config", "default.toml"));
  }
  if (home) {
    if (darwin) {
      // Native (xdg-portable macOS config()): ~/Library/Preferences/.wrangler.
      candidates.push(join(home, "Library", "Preferences", ".wrangler", "config", "default.toml"));
    } else if (windows) {
      // Native (xdg-portable Windows config()): %APPDATA%\xdg.config\.wrangler
      // where %APPDATA% falls back to ~\AppData\Roaming.
      const appData = env.APPDATA || join(home, "AppData", "Roaming");
      candidates.push(join(appData, "xdg.config", ".wrangler", "config", "default.toml"));
    } else {
      // Linux/other (xdg-portable Linux config()): ~/.config/.wrangler.
      candidates.push(join(home, ".config", ".wrangler", "config", "default.toml"));
    }
    // Legacy ~/.wrangler dir override, kept by wrangler for backwards compat
    // (getGlobalConfigPath checks os.homedir()/.wrangler before the XDG dir).
    candidates.push(join(home, ".wrangler", "config", "default.toml"));
  }
  return candidates.filter((path, index) => candidates.indexOf(path) === index);
}

export function parseOauthToken(tomlContent) {
  if (typeof tomlContent !== "string") return undefined;
  const match = tomlContent.match(/^\s*oauth_token\s*=\s*"([^"]+)"/m);
  return match ? match[1] : undefined;
}

export async function resolveWranglerAuthToken(paths, readFile) {
  for (const path of paths) {
    let content;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    const token = parseOauthToken(content);
    if (token) return { token, path };
  }
  return { token: undefined, path: undefined };
}

export async function findEncryptedWranglerConfig(paths, stat) {
  // `wrangler login --use-keyring` stores an encrypted `default.enc` (key in
  // the OS keychain) and deletes the plaintext token — this script cannot read
  // it, so detect it and fail with actionable instructions.
  for (const path of paths) {
    const encPath = path.replace(/default\.toml$/, "default.enc");
    try {
      await stat(encPath);
      return encPath;
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
  }
  return undefined;
}

export async function describeApiError(response, fallback) {
  const base = `${fallback} (HTTP ${response.status})`;
  let data;
  try {
    data = await response.json();
  } catch {
    return base;
  }
  const errors = (data && data.errors) || [];
  if (!Array.isArray(errors) || errors.length === 0) return base;
  const details = errors
    .map((e) =>
      e && e.code !== undefined ? `[${e.code}] ${e.message || ""}` : (e && e.message) || "",
    )
    .filter(Boolean)
    .join(", ");
  return details ? `${base}: ${details}` : base;
}

// --- Zero Trust team domain resolution -------------------------------------
// Verified live app objects carry `aud` but NO `team_domain`/`access_app_id`
// field. The team domain lives only on
// `GET /accounts/{accountId}/access/organizations`. The official API schema
// (developers.cloudflare.com/api/resources/zero_trust/subresources/
// organizations/methods/list/) documents the field as `result.auth_domain`
// ("The unique subdomain assigned to your Zero Trust organization", e.g.
// "test.cloudflareaccess.com"); `domain` is not in the schema, but it IS what
// live accounts return (verified on the human's account). Read both, so a
// fresh account that only exposes the documented shape still resolves:
// `result.domain ?? result.auth_domain`. The endpoint needs the separate
// "Access: Organizations, Identity Providers, and Groups" token permission —
// many provisioning tokens 403 ([10000]) there. Resolution order: explicit
// option -> SETUP_ACCESS_TEAM_DOMAIN -> org endpoint (a non-OK/403/[10000]
// response must not crash) -> interactive prompt -> throw. In headless mode
// the injected prompt already throws deterministically naming
// SETUP_ACCESS_TEAM_DOMAIN (see PROMPT_ENV_OVERRIDES).

export const TEAM_DOMAIN_PROMPT = "Zero Trust team domain (e.g. yourteam.cloudflareaccess.com):";

export async function resolveTeamDomain({ accessTeamDomain, env = {}, accountId, api, prompt }) {
  if (accessTeamDomain && String(accessTeamDomain).trim()) {
    return String(accessTeamDomain).trim();
  }
  const fromEnv = env.SETUP_ACCESS_TEAM_DOMAIN && String(env.SETUP_ACCESS_TEAM_DOMAIN).trim();
  if (fromEnv) return fromEnv;
  if (accountId && api) {
    try {
      const orgRes = await api("GET", `/accounts/${accountId}/access/organizations`);
      if (orgRes && orgRes.ok) {
        const data = await orgRes.json();
        const domain = data && data.result && (data.result.domain ?? data.result.auth_domain);
        if (domain && String(domain).trim()) return String(domain).trim();
      }
    } catch {
      // A 403/[10000]/non-OK org response (or a thrown error) falls through to
      // the prompt / headless throw instead of crashing the run.
    }
  }
  if (prompt) {
    const answer = String((await prompt(TEAM_DOMAIN_PROMPT, "")) || "").trim();
    if (answer) return answer;
  }
  throw new Error(
    "Could not determine Access team domain. Provide it when prompted, or set the " +
      "SETUP_ACCESS_TEAM_DOMAIN environment variable and re-run.",
  );
}

// --- Covering-zone lookup ---------------------------------------------------
// `GET /zones?name=` is an EXACT match, so a subdomain (`cdn.n.3a8r.com`)
// returns zero results. Strip the leftmost label and retry
// (`n.3a8r.com` -> `3a8r.com`) until a covering zone is found or no labels
// remain. Domains are normalized first (schemes, trailing slashes AND
// trailing dots stripped) and empty candidates are skipped, so `/zones?name=`
// is never called with a blank name (a strict API would 400 it). A non-OK
// response throws with describeApiError; not finding any zone returns
// undefined (runSetup logs a clear error, per ADR 0030).

export function zoneCandidates(domain) {
  const parts = normalizeDomain(domain).split(".");
  const candidates = [];
  for (let i = 0; i < parts.length; i++) {
    const candidate = parts.slice(i).join(".");
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export async function findCoveringZone(domain, api) {
  for (const candidate of zoneCandidates(domain)) {
    const res = await api("GET", `/zones?name=${encodeURIComponent(candidate)}`);
    if (!res.ok) {
      throw new Error(await describeApiError(res, "Failed to look up Cloudflare zone"));
    }
    const data = await res.json();
    const zones = (data && data.result) || [];
    if (Array.isArray(zones) && zones.length > 0) return zones[0];
  }
  return undefined;
}

// --- Provisioning error mapping --------------------------------------------
// R2 returns code 10042 when R2 is not enabled on the account; D1 returns
// code 10000 (Authentication error) when the token lacks the D1 permission.
// Those get actionable, secret-free messages; everything else falls back to
// describeApiError (which reuses the response body, so no double-consume).

export const PROVISIONING_ERROR_MESSAGES = {
  10042:
    "R2 is not enabled on this Cloudflare account. Enable it in the Cloudflare dashboard (R2 > Overview), then re-run.",
  10000:
    "The Cloudflare API token is missing the D1 permission. Add Account → D1: Edit (see docs/operations/README.md 'API token scopes'), then re-run.",
};

export async function provisioningError(response, fallback, codes = []) {
  try {
    const data = await response.json();
    const errors = (data && data.errors) || [];
    if (Array.isArray(errors)) {
      for (const e of errors) {
        if (
          e &&
          e.code !== undefined &&
          codes.includes(e.code) &&
          PROVISIONING_ERROR_MESSAGES[e.code]
        ) {
          return PROVISIONING_ERROR_MESSAGES[e.code];
        }
      }
    }
  } catch {
    // Unreadable body: fall through to the generic describeApiError path.
  }
  return describeApiError(response, fallback);
}

export function createApiClient({ env = {}, oauthToken, resolveOauthToken, fetchImpl }) {
  const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
  if (!doFetch) throw new Error("No fetch implementation available");
  let cachedOauthToken = oauthToken;

  const resolveToken = async () => {
    const envToken = env.CLOUDFLARE_API_TOKEN;
    if (envToken) return envToken;
    if (cachedOauthToken) return cachedOauthToken;
    if (resolveOauthToken) {
      const result = await resolveOauthToken();
      cachedOauthToken = result && result.token;
      if (cachedOauthToken) return cachedOauthToken;
    }
    throw new Error(
      "No Cloudflare credentials available: set CLOUDFLARE_API_TOKEN, or run `wrangler login` first.",
    );
  };

  return async (method, path, body) => {
    const token = await resolveToken();
    const response = await doFetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, json: async () => data };
  };
}

async function isAccessNotInitializedError(response) {
  const data = await response.json();
  if (response.ok) return { notInitialized: false, data };
  if (!data) return { notInitialized: false, data };
  const errors = data.errors || [];
  const notInitialized = errors.some(
    (e) =>
      /access\s+not\s+enabled/i.test(e.message || "") ||
      /zero\s+trust/i.test(e.message || "") ||
      e.code === 1000 ||
      e.code === 1047,
  );
  return { notInitialized, data };
}

export async function runSetup(options, deps) {
  const { fs, wrangler, api, prompt, confirm, log, pause } = deps;
  const opts = { ...DEFAULTS, ...options };
  const env = deps.env || {};
  const headless = opts.headless === true;

  // Headless mode must never wait on a human: prompt falls back to its default
  // or throws naming the missing value; confirm uses its default; the Zero
  // Trust pause becomes a deterministic, actionable error.
  const promptFn = headless
    ? async (message, defaultValue) => {
        if (defaultValue) return defaultValue;
        const entry = PROMPT_ENV_OVERRIDES.find((e) => message.includes(e.match));
        const label = entry ? entry.label : message.replace(/[:…].*$/, "").trim() || "value";
        const envVar = entry ? entry.env : "SETUP_*";
        throw new Error(
          `Missing required value: ${label}. Set the ${envVar} environment variable, or run setup interactively.`,
        );
      }
    : prompt;
  const confirmFn = headless ? async (_message, defaultValue = true) => defaultValue : confirm;
  const pauseFn = headless
    ? async () => {
        throw new Error(
          "Cloudflare Access / Zero Trust is not initialized. Complete the one-time setup at " +
            "https://one.dash.cloudflare.com/ (choose a team name, e.g. yourteam), then re-run " +
            "this workflow.",
        );
      }
    : pause;

  // --- 1. Verify Node.js version and wrangler availability ----------------
  if (typeof process !== "undefined" && process.version) {
    const major = parseInt(process.version.slice(1).split(".")[0], 10);
    if (major < opts.minNodeVersion) {
      throw new Error(`Node.js >= ${opts.minNodeVersion} is required. Got: ${process.version}`);
    }
  }

  if (typeof wrangler !== "function") {
    throw new Error("wrangler runner is required");
  }

  // --- 2. Determine authentication ----------------------------------------
  let apiToken = opts.apiToken || env.CLOUDFLARE_API_TOKEN || null;
  let useWranglerLogin = !apiToken && opts.useWranglerLogin !== false;

  if (useWranglerLogin) {
    if (headless) {
      throw new Error(
        "No CLOUDFLARE_API_TOKEN found. In non-interactive (headless) mode, set " +
          "CLOUDFLARE_API_TOKEN (and CLOUDFLARE_ACCOUNT_ID) in the environment before running setup.",
      );
    }
    if (!opts.skipAuth) {
      log("No CLOUDFLARE_API_TOKEN found. Running wrangler login (interactive browser)...");
      const loginResult = await wrangler(["login"]);
      if (loginResult.exitCode !== 0) {
        throw new Error(`wrangler login failed: ${loginResult.stderr || loginResult.stdout}`);
      }
    }
  }

  if (apiToken) {
    log("Using API token for Cloudflare API calls.");
  } else {
    log("Using wrangler OAuth credentials for Cloudflare API calls.");
  }

  // --- 3. Resolve account ID ----------------------------------------------
  let accountId = opts.accountId || env.CLOUDFLARE_ACCOUNT_ID || null;
  if (!accountId) {
    const whoami = await wrangler(["whoami"]);
    const match =
      whoami.stdout.match(/Account ID\s+([a-f0-9]+)/i) ||
      whoami.stdout.match(/"account_id"\s*:\s*"([^"]+)"/) ||
      whoami.stdout.match(/([a-f0-9]{32})/i);
    if (match) accountId = match[1];
  }
  if (!accountId) {
    accountId = await promptFn("Cloudflare account ID:", "");
  }
  if (!accountId) {
    throw new Error("Cloudflare account ID is required.");
  }

  // --- 4. Prompt for inputs -----------------------------------------------
  const workerDomain = normalizeDomain(
    opts.workerDomain ||
      (await promptFn("Worker domain (e.g., pages.example.com):", "pages.example.com")),
  );
  const cdnDomain = normalizeDomain(
    opts.cdnDomain ||
      (await promptFn(
        "CDN / asset domain (e.g., cdn.pages.example.com):",
        "cdn.pages.example.com",
      )),
  );
  const projectName = (
    opts.projectName || (await promptFn("Project name (used for resource names):", "pagelively"))
  ).trim();
  const adminEmails = parseAdminEmails(
    opts.adminEmails || (await promptFn("Admin email(s), comma-separated:", "")),
  );

  if (adminEmails.length === 0) {
    throw new Error("At least one admin email is required.");
  }

  const createKv =
    opts.createKv !== undefined
      ? opts.createKv
      : await confirmFn("Create an optional KV namespace for JWKS caching?", true);

  const bucketName = opts.bucketName || deriveBucketName(projectName);
  const dbName = opts.dbName || deriveDbName(projectName);
  const kvName = opts.kvName || deriveKvName(projectName);

  const assetBaseUrl = `https://${cdnDomain}`;

  log(`\nProvisioning project "${projectName}" for ${workerDomain} (CDN: ${cdnDomain})...\n`);

  // --- 5. Cloudflare Access / Zero Trust check ----------------------------
  log("Checking Cloudflare Access / Zero Trust...");
  const accessAppsRes = await api("GET", `/accounts/${accountId}/access/apps`);
  const { notInitialized: accessNotInitialized, data: accessAppsData } =
    await isAccessNotInitializedError(accessAppsRes);
  if (!accessAppsRes.ok && accessNotInitialized) {
    log("");
    log("Cloudflare Access / Zero Trust is not initialized for this account.");
    log("One-time setup is required before this script can continue:");
    log("  1. Go to https://one.dash.cloudflare.com/");
    log("  2. Choose a team name (e.g., yourteam).");
    log("  3. (Optional) set up your identity provider (email OTP is fine).");
    log("  4. Re-run this script.");
    log("");
    await pauseFn("Press Enter once Zero Trust is initialized...");
    return;
  }
  if (!accessAppsRes.ok) {
    throw new Error(await describeApiError(accessAppsRes, "Failed to list Access apps"));
  }
  const accessApps = accessAppsData?.result || [];

  // --- 6. Find or create Access application -------------------------------
  const appName = `${projectName} admin`;

  // The Access application must protect EXACTLY `${host}/admin` and `${host}/api`
  // (spec §9) and nothing else. Creating it with `domain: workerDomain` and no
  // path scopes the app to the ENTIRE worker domain, so Access prompts on every
  // public URL (live bug: public content URLs required Access auth). Verified
  // against the current API reference and the app-paths doc:
  //   https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/
  //   https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/update/
  //   https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/
  // `destinations` (PublicDestination uri, path-capable) supersedes the
  // deprecated `self_hosted_domains` field.
  const accessPathSpecs = [{ path: "/admin" }, { path: "/api" }];

  function normalizeAccessUri(uri) {
    return String(uri)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");
  }

  function requiredDestinations(host) {
    return accessPathSpecs.map((spec) => ({ type: "public", uri: `${host}${spec.path}` }));
  }

  function requiredDomain(host) {
    return `${host}${accessPathSpecs[0].path}`;
  }

  // The set of protected URIs of an existing app: public destinations PLUS the
  // legacy top-level `domain` (treated as a URI). Normalized; empties dropped.
  function appProtectedUris(app) {
    const uris = [];
    if (Array.isArray(app.destinations)) {
      for (const d of app.destinations) {
        if (d && d.type === "public" && d.uri) uris.push(d.uri);
      }
    }
    if (app.domain) uris.push(app.domain);
    return uris.map(normalizeAccessUri).filter((u) => u.length > 0);
  }

  // Correct scope is EXACTLY {host/admin, host/api} — nothing more, nothing
  // less, so whole-domain entries like `host` or `host/*` are detected as wrong.
  function isCorrectlyScoped(app, host) {
    const required = new Set([
      normalizeAccessUri(requiredDomain(host)),
      ...requiredDestinations(host).map((d) => normalizeAccessUri(d.uri)),
    ]);
    const actual = new Set(appProtectedUris(app));
    if (required.size !== actual.size) return false;
    for (const uri of required) if (!actual.has(uri)) return false;
    return true;
  }

  // The worker host an app is scoped to: `a.domain` split("/")[0] OR the host
  // portion of any public destination uri (scheme stripped defensively).
  function accessHostOf(app) {
    const hosts = new Set();
    const hostFrom = (uri) => {
      const h = normalizeDomain(
        String(uri)
          .replace(/^https?:\/\//, "")
          .split("/")[0],
      );
      if (h) hosts.add(h);
    };
    if (app.domain) hostFrom(app.domain);
    if (Array.isArray(app.destinations)) {
      for (const d of app.destinations) {
        if (d && d.type === "public" && d.uri) hostFrom(d.uri);
      }
    }
    return [...hosts];
  }

  const accessHost = normalizeDomain(workerDomain);
  let app = accessApps.find((a) => {
    const nameMatch = a.name && a.name.toLowerCase() === appName.toLowerCase();
    const hosts = accessHostOf(a);
    // Lenient: an app with no scope info at all still matches, as do legacy
    // whole-domain apps (a.domain === workerDomain).
    const hostMatch = hosts.length === 0 || hosts.includes(accessHost);
    return nameMatch && hostMatch;
  });

  if (!app) {
    log("Creating Cloudflare Access application...");
    const createAppRes = await api("POST", `/accounts/${accountId}/access/apps`, {
      name: appName,
      type: "self_hosted",
      domain: requiredDomain(accessHost),
      destinations: requiredDestinations(accessHost),
      session_duration: "24h",
      app_launcher_visible: false,
      policies: [],
    });
    if (!createAppRes.ok) {
      throw new Error(await describeApiError(createAppRes, "Failed to create Access application"));
    }
    const createAppData = await createAppRes.json();
    app = createAppData.result;
  } else if (!isCorrectlyScoped(app, accessHost)) {
    // Found an app for this host that protects the whole domain or is otherwise
    // not scoped to exactly /admin and /api. Fix it in place with PUT — the app
    // id (and therefore its aud, derived from the id) is stable, so ACCESS_AUD
    // in wrangler.toml keeps working. The allow-admins policy is re-verified
    // separately below, so `policies` is deliberately omitted here.
    log(
      "Access application found but protects the whole domain / is not scoped to /admin and /api; updating in place...",
    );
    const updateAppRes = await api("PUT", `/accounts/${accountId}/access/apps/${app.id}`, {
      name: appName,
      type: "self_hosted",
      domain: requiredDomain(accessHost),
      destinations: requiredDestinations(accessHost),
      session_duration: app.session_duration ?? "24h",
      app_launcher_visible: app.app_launcher_visible ?? false,
    });
    if (!updateAppRes.ok) {
      throw new Error(await describeApiError(updateAppRes, "Failed to update Access application"));
    }
  } else {
    log("Cloudflare Access application already correctly scoped; skipping update.");
  }

  const appId = app.id;
  const accessAud = app.aud;

  if (!accessAud) {
    // Fetch full app details when aud is not present in the list response.
    const appRes = await api("GET", `/accounts/${accountId}/access/apps/${appId}`);
    if (!appRes.ok) {
      throw new Error(await describeApiError(appRes, "Failed to fetch Access application details"));
    }
    const appData = await appRes.json();
    app = appData.result;
  }

  const finalAccessAud = app.aud || accessAud;

  if (!finalAccessAud) {
    throw new Error("Could not determine Access application AUD tag.");
  }

  // The Access app object has no team_domain field (verified live keys);
  // resolve it via option -> SETUP_ACCESS_TEAM_DOMAIN -> org endpoint ->
  // interactive prompt (headless throws naming SETUP_ACCESS_TEAM_DOMAIN).
  const finalAccessTeamDomain = await resolveTeamDomain({
    accessTeamDomain: opts.accessTeamDomain,
    env,
    accountId,
    api,
    prompt: promptFn,
  });

  // --- 7. Create or reuse Access policy -----------------------------------
  const appPoliciesRes = await api("GET", `/accounts/${accountId}/access/apps/${appId}/policies`);
  if (!appPoliciesRes.ok) {
    throw new Error(await describeApiError(appPoliciesRes, "Failed to list Access policies"));
  }
  const appPoliciesData = await appPoliciesRes.json();
  const appPolicies = appPoliciesData.result || [];
  const policyName = `${projectName} allow-admins`;
  const hasPolicy = appPolicies.some(
    (p) => p.name && p.name.toLowerCase() === policyName.toLowerCase(),
  );

  if (!hasPolicy) {
    log("Creating Access policy for admin emails...");
    const emailRules = adminEmails.map((email) => ({ email: { email } }));
    const createPolicyRes = await api(
      "POST",
      `/accounts/${accountId}/access/apps/${appId}/policies`,
      {
        name: policyName,
        decision: "allow",
        include: emailRules,
        precedence: 1,
      },
    );
    if (!createPolicyRes.ok) {
      throw new Error(await describeApiError(createPolicyRes, "Failed to create Access policy"));
    }
  } else {
    log("Access policy already exists; skipping create.");
  }

  // --- 8. Verify zones ----------------------------------------------------
  // GET /zones?name= is an exact match, so subdomains are resolved to their
  // covering zone by stripping leftmost labels (n.3a8r.com -> 3a8r.com).
  log("Looking up Cloudflare zones...");
  const workerZone = await findCoveringZone(workerDomain, api);
  if (workerZone) {
    log(`Resolved zone for ${workerDomain}: ${workerZone.name} (${workerZone.id})`);
  }
  const cdnZone = await findCoveringZone(cdnDomain, api);
  if (cdnZone) {
    log(`Resolved zone for ${cdnDomain}: ${cdnZone.name} (${cdnZone.id})`);
  }

  if (!workerZone) {
    log("");
    log(`ERROR: The zone for ${workerDomain} was not found in this Cloudflare account.`);
    log("Make sure the domain has been added to Cloudflare before deploying.");
    log("");
    return;
  }
  if (!cdnZone) {
    log("");
    log(`ERROR: The zone for ${cdnDomain} was not found in this Cloudflare account.`);
    log("Make sure the subdomain is covered by a zone in the same account before deploying.");
    log("");
    return;
  }

  const cdnZoneId = cdnZone.id;

  // --- 9. Ensure R2 bucket exists -----------------------------------------
  log("Checking R2 bucket...");
  const bucketsRes = await api("GET", `/accounts/${accountId}/r2/buckets`);
  if (!bucketsRes.ok) {
    throw new Error(await provisioningError(bucketsRes, "Failed to list R2 buckets", [10042]));
  }
  const bucketsData = await bucketsRes.json();
  const buckets = (bucketsData.result && bucketsData.result.buckets) || [];
  let bucket = buckets.find((b) => b.name === bucketName);

  if (!bucket) {
    log("Creating R2 bucket...");
    const createBucketRes = await api("POST", `/accounts/${accountId}/r2/buckets`, {
      name: bucketName,
    });
    if (!createBucketRes.ok) {
      throw new Error(
        await provisioningError(createBucketRes, "Failed to create R2 bucket", [10042]),
      );
    }
    const createBucketData = await createBucketRes.json();
    bucket = createBucketData.result;
  } else {
    log("R2 bucket already exists; skipping create.");
  }

  // --- 10. Connect R2 bucket to CDN domain -------------------------------
  // Body fields verified against the official API schema
  // (developers.cloudflare.com/api/resources/r2/subresources/buckets/
  // subresources/domains/subresources/custom/methods/create/): `zoneId`
  // (camelCase, REQUIRED — sending `zone_id` 400s) and `domain` are required;
  // `enabled` is optional and defaults to true. A 409 means the domain is
  // already connected (idempotent re-run), so it is not an error.
  log("Connecting R2 bucket to CDN domain...");
  const customDomainRes = await api(
    "POST",
    `/accounts/${accountId}/r2/buckets/${bucketName}/domains/custom`,
    {
      domain: cdnDomain,
      zoneId: cdnZoneId,
      enabled: true,
    },
  );
  if (!customDomainRes.ok && customDomainRes.status !== 409) {
    throw new Error(await describeApiError(customDomainRes, "Failed to connect R2 custom domain"));
  }
  if (customDomainRes.status === 409) {
    log("R2 custom domain already connected; skipping create.");
  }

  // --- 11. Ensure D1 database exists -------------------------------------
  log("Checking D1 database...");
  const dbsRes = await api("GET", `/accounts/${accountId}/d1/database`);
  if (!dbsRes.ok) {
    throw new Error(await provisioningError(dbsRes, "Failed to list D1 databases", [10000]));
  }
  const dbsData = await dbsRes.json();
  const databases = dbsData.result || [];
  let db = databases.find((d) => d.name === dbName);

  if (!db) {
    log("Creating D1 database...");
    const createDbRes = await api("POST", `/accounts/${accountId}/d1/database`, { name: dbName });
    if (!createDbRes.ok) {
      throw new Error(
        await provisioningError(createDbRes, "Failed to create D1 database", [10000]),
      );
    }
    const createDbData = await createDbRes.json();
    db = createDbData.result;
  } else {
    log("D1 database already exists; skipping create.");
  }

  // --- 12. Ensure KV namespace exists (optional) -------------------------
  let kvId = null;
  if (createKv) {
    log("Checking KV namespace...");
    const kvsRes = await api("GET", `/accounts/${accountId}/storage/kv/namespaces`);
    if (!kvsRes.ok) {
      throw new Error(`Failed to list KV namespaces: ${kvsRes.status}`);
    }
    const kvsData = await kvsRes.json();
    const namespaces = kvsData.result || [];
    let kv = namespaces.find((n) => n.title === kvName);

    if (!kv) {
      log("Creating KV namespace...");
      const createKvRes = await api("POST", `/accounts/${accountId}/storage/kv/namespaces`, {
        title: kvName,
      });
      if (!createKvRes.ok) {
        throw new Error(`Failed to create KV namespace: ${createKvRes.status}`);
      }
      const createKvData = await createKvRes.json();
      kv = createKvData.result;
    } else {
      log("KV namespace already exists; skipping create.");
    }
    kvId = kv.id;
  }

  // --- 13. Write resource IDs to wrangler.toml ---------------------------
  log("Updating wrangler.toml...");
  const tomlPath = opts.wranglerToml || DEFAULTS.wranglerToml;
  const tomlContent = await fs.readFile(tomlPath, "utf8");
  const updatedToml = updateWranglerToml(tomlContent, {
    bucketName,
    dbName,
    dbId: db.uuid || db.id || db.database_id,
    assetBaseUrl,
    accessTeamDomain: finalAccessTeamDomain,
    accessAud: finalAccessAud,
    kvId,
    workerDomain,
  });
  await fs.writeFile(tomlPath, updatedToml);

  // --- 14. Apply D1 migrations -------------------------------------------
  log("Applying D1 migrations...");
  const migrateResult = await wrangler(["d1", "migrations", "apply", dbName, "--remote"]);
  if (migrateResult.exitCode !== 0) {
    throw new Error(`D1 migrations failed: ${migrateResult.stderr || migrateResult.stdout}`);
  }

  // --- 15. Deploy Worker ---------------------------------------------------
  log("Deploying Worker...");
  const deployResult = await wrangler(["deploy"]);
  if (deployResult.exitCode !== 0) {
    throw new Error(`wrangler deploy failed: ${deployResult.stderr || deployResult.stdout}`);
  }

  // --- 16. Print final URLs ----------------------------------------------
  log("");
  log("Pagelively is live!");
  log(`  Worker URL:  https://${workerDomain}/`);
  log(`  Admin URL:   https://${workerDomain}/admin`);
  log(`  CDN URL:     ${assetBaseUrl}/`);
  log("");
  log(`Access protects: https://${accessHost}/admin and https://${accessHost}/api`);
  log("Access is enforced on /admin* and /api/* for:");
  for (const email of adminEmails) {
    log(`  - ${email}`);
  }
  log("");
  log("Run this script again any time to resume or update resources safely.");
}

// --- Main entry point (Node.js only) ---------------------------------------

async function buildRealDeps() {
  const [{ readFile, writeFile, stat }, { spawn }, readlineModule, { env }, os] = await Promise.all(
    [
      import("node:fs/promises"),
      import("node:child_process"),
      import("node:readline/promises"),
      import("node:process"),
      import("node:os"),
    ],
  );

  const rl = readlineModule.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const wrangler = async (args) => {
    return new Promise((resolve, reject) => {
      const child = spawn("npx", ["wrangler", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.on("error", (err) => reject(err));
      child.on("close", (exitCode) => {
        resolve({ stdout, stderr, exitCode });
      });
    });
  };

  const prompt = async (message, defaultValue) => {
    const answer = await rl.question(`${message} ${defaultValue ? `[${defaultValue}] ` : ""}`);
    return answer.trim() || defaultValue || "";
  };

  const confirm = async (message, defaultValue = true) => {
    const suffix = defaultValue ? "[Y/n]" : "[y/N]";
    const answer = await rl.question(`${message} ${suffix} `);
    const value = answer.trim().toLowerCase();
    if (value === "") return defaultValue;
    return value === "y" || value === "yes";
  };

  const log = (message) => {
    console.log(message);
  };

  const pause = async (message) => {
    await rl.question(message);
  };

  const api = (() => {
    if (env.CLOUDFLARE_API_TOKEN) {
      return createApiClient({ env, fetchImpl: fetch });
    }
    // Interactive mode: `wrangler login` (run inside runSetup) stores OAuth
    // credentials in the global wrangler config dir. Resolve the token lazily
    // on the first API call — which happens after login — and fail fast when
    // the only credential present is an unreadable keyring-encrypted one.
    const configPaths = wranglerConfigPaths(env, { homedir: os.homedir, platform: os.platform });
    const readOauth = async () => {
      const encrypted = await findEncryptedWranglerConfig(configPaths, stat);
      if (encrypted) {
        throw new Error(
          `Found an encrypted wrangler OAuth credential at ${encrypted}, which this script ` +
            "cannot read. Re-run `wrangler login --no-use-keyring` to store the token as " +
            "plaintext, or set CLOUDFLARE_API_TOKEN and re-run setup.",
        );
      }
      return resolveWranglerAuthToken(configPaths, readFile);
    };
    return createApiClient({ env, resolveOauthToken: readOauth, fetchImpl: fetch });
  })();

  return {
    fs: { readFile, writeFile },
    wrangler,
    api,
    prompt,
    confirm,
    log,
    pause,
    env,
    rl,
  };
}

async function main() {
  const deps = await buildRealDeps();
  // Headless/CI: SETUP_WORKER_DOMAIN, SETUP_CDN_DOMAIN, SETUP_PROJECT_NAME,
  // ADMIN_EMAILS, SETUP_CREATE_KV, SETUP_NON_INTERACTIVE (see
  // envToSetupOptions). Interactive humans still get every prompt.
  await runSetup(envToSetupOptions(deps.env || {}), deps);
  if (deps.rl && typeof deps.rl.close === "function") {
    deps.rl.close();
  }
}

if (
  typeof process !== "undefined" &&
  process.argv &&
  process.argv[1] &&
  process.argv[1].endsWith("setup.mjs")
) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
