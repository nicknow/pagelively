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
    .replace(/\/+$/, "");
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
    throw new Error(`Failed to list Access apps: ${accessAppsRes.status}`);
  }
  const accessApps = accessAppsData?.result || [];

  // --- 6. Find or create Access application -------------------------------
  const appName = `${projectName} admin`;
  let app = accessApps.find((a) => {
    const nameMatch = a.name && a.name.toLowerCase() === appName.toLowerCase();
    const domainMatch = !a.domain || a.domain === workerDomain;
    return nameMatch && domainMatch;
  });

  if (!app) {
    log("Creating Cloudflare Access application...");
    const createAppRes = await api("POST", `/accounts/${accountId}/access/apps`, {
      name: appName,
      domain: workerDomain,
      type: "self_hosted",
      session_duration: "24h",
      app_launcher_visible: false,
      policies: [],
    });
    if (!createAppRes.ok) {
      throw new Error(`Failed to create Access application: ${createAppRes.status}`);
    }
    const createAppData = await createAppRes.json();
    app = createAppData.result;
  } else {
    log("Cloudflare Access application already exists; skipping create.");
  }

  const appId = app.id;
  const accessAud = app.aud;

  let accessTeamDomain = opts.accessTeamDomain || app.access_app_id || app.team_domain;

  if (!accessAud || !accessTeamDomain) {
    // Fetch full app details if aud/team domain not in list response
    const appRes = await api("GET", `/accounts/${accountId}/access/apps/${appId}`);
    if (!appRes.ok) {
      throw new Error(`Failed to fetch Access application details: ${appRes.status}`);
    }
    const appData = await appRes.json();
    app = appData.result;
    accessTeamDomain = accessTeamDomain || app.access_app_id || app.team_domain;
  }

  const finalAccessAud = app.aud || accessAud;
  const finalAccessTeamDomain =
    opts.accessTeamDomain || accessTeamDomain || app.access_app_id || app.team_domain;

  if (!finalAccessAud) {
    throw new Error("Could not determine Access application AUD tag.");
  }

  if (!finalAccessTeamDomain) {
    throw new Error("Could not determine Access team domain.");
  }

  // --- 7. Create or reuse Access policy -----------------------------------
  const appPoliciesRes = await api("GET", `/accounts/${accountId}/access/apps/${appId}/policies`);
  const appPoliciesData = appPoliciesRes.ok ? await appPoliciesRes.json() : { result: [] };
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
      throw new Error(`Failed to create Access policy: ${createPolicyRes.status}`);
    }
  } else {
    log("Access policy already exists; skipping create.");
  }

  // --- 8. Verify zones ----------------------------------------------------
  log("Looking up Cloudflare zones...");
  const workerZoneRes = await api("GET", `/zones?name=${encodeURIComponent(workerDomain)}`);
  const cdnZoneRes = await api("GET", `/zones?name=${encodeURIComponent(cdnDomain)}`);

  if (!workerZoneRes.ok || !cdnZoneRes.ok) {
    throw new Error("Failed to look up Cloudflare zones.");
  }

  const workerZoneData = await workerZoneRes.json();
  const cdnZoneData = await cdnZoneRes.json();
  const workerZones = workerZoneData.result || [];
  const cdnZones = cdnZoneData.result || [];

  if (workerZones.length === 0) {
    log("");
    log(`ERROR: The zone for ${workerDomain} was not found in this Cloudflare account.`);
    log("Make sure the domain has been added to Cloudflare before deploying.");
    log("");
    return;
  }
  if (cdnZones.length === 0) {
    log("");
    log(`ERROR: The zone for ${cdnDomain} was not found in this Cloudflare account.`);
    log("Make sure the subdomain is covered by a zone in the same account before deploying.");
    log("");
    return;
  }

  const cdnZoneId = cdnZones[0].id;

  // --- 9. Ensure R2 bucket exists -----------------------------------------
  log("Checking R2 bucket...");
  const bucketsRes = await api("GET", `/accounts/${accountId}/r2/buckets`);
  if (!bucketsRes.ok) {
    throw new Error(`Failed to list R2 buckets: ${bucketsRes.status}`);
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
      throw new Error(`Failed to create R2 bucket: ${createBucketRes.status}`);
    }
    const createBucketData = await createBucketRes.json();
    bucket = createBucketData.result;
  } else {
    log("R2 bucket already exists; skipping create.");
  }

  // --- 10. Connect R2 bucket to CDN domain -------------------------------
  log("Connecting R2 bucket to CDN domain...");
  const customDomainRes = await api(
    "POST",
    `/accounts/${accountId}/r2/buckets/${bucketName}/domains/custom`,
    {
      domain: cdnDomain,
      zone_id: cdnZoneId,
      enabled: true,
    },
  );
  if (!customDomainRes.ok && customDomainRes.status !== 409) {
    throw new Error(`Failed to connect R2 custom domain: ${customDomainRes.status}`);
  }
  if (customDomainRes.status === 409) {
    log("R2 custom domain already connected; skipping create.");
  }

  // --- 11. Ensure D1 database exists -------------------------------------
  log("Checking D1 database...");
  const dbsRes = await api("GET", `/accounts/${accountId}/d1/database`);
  if (!dbsRes.ok) {
    throw new Error(`Failed to list D1 databases: ${dbsRes.status}`);
  }
  const dbsData = await dbsRes.json();
  const databases = dbsData.result || [];
  let db = databases.find((d) => d.name === dbName);

  if (!db) {
    log("Creating D1 database...");
    const createDbRes = await api("POST", `/accounts/${accountId}/d1/database`, { name: dbName });
    if (!createDbRes.ok) {
      throw new Error(`Failed to create D1 database: ${createDbRes.status}`);
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
  log("Access is enforced on /admin* and /api/* for:");
  for (const email of adminEmails) {
    log(`  - ${email}`);
  }
  log("");
  log("Run this script again any time to resume or update resources safely.");
}

// --- Main entry point (Node.js only) ---------------------------------------

async function buildRealDeps() {
  const [{ readFile, writeFile }, { spawn }, readlineModule, { env }] = await Promise.all([
    import("node:fs/promises"),
    import("node:child_process"),
    import("node:readline/promises"),
    import("node:process"),
  ]);

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

  const api = async (method, path, body) => {
    const token = env.CLOUDFLARE_API_TOKEN;
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    return { ok: response.ok, status: response.status, json: async () => data };
  };

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
