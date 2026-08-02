# Operations (`docs/operations/`)

Everything a human needs to provision, deploy, and run Pagelively for real.

## Status

Provisioning guide written for S20. Smoke-test checklist in `smoke-test-checklist.md`.

## Prerequisites

- **Node.js** 22 or newer (the devcontainer pre-installs it).
- **Cloudflare account** with the target domain added as a zone.
- **Cloudflare Zero Trust initialized** (a team name, e.g. `yourteam.cloudflareaccess.com`). One-time setup; see below.
- Either:
  - A **Cloudflare API token** with the scopes listed below (headless / CI), or
  - A browser for **interactive `wrangler login`** (local use).

## One-time: Cloudflare Zero Trust

Pagelively uses Cloudflare Access (Zero Trust) to protect `/admin*` and `/api/*`. Before running `setup.mjs`:

1. Go to <https://one.dash.cloudflare.com/>.
2. Choose a team name (this becomes `yourteam.cloudflareaccess.com`).
3. (Optional) Configure an identity provider; email OTP is enough for a single-user setup.

If Zero Trust is not initialized when you run `setup.mjs`, the script will print these steps and pause until you press Enter.

## API token scopes

Create a token at <https://dash.cloudflare.com/profile/api-tokens> with:

- **Account** → Workers Scripts: _Edit_, Workers R2 Storage: _Edit_, D1: _Edit_ (read-only is
  not enough), Workers KV Storage: _Edit_ (if KV is used), Access: Apps and Policies: _Edit_,
  Account Settings: _Read_.
- **Zone** (for your target domain) → DNS: _Edit_, Workers Routes: _Edit_.
- **R2 must be enabled** on the account (R2 → Overview) before setup runs.

The team domain (`yourteam.cloudflareaccess.com`) is resolved automatically: setup first tries
`SETUP_ACCESS_TEAM_DOMAIN` (set it to skip the lookup entirely, e.g. in CI), otherwise the
Access organizations endpoint (`GET /accounts/{accountId}/access/organizations` →
`result.domain ?? result.auth_domain`; the API schema documents `auth_domain`, live accounts
may return `domain`, and setup reads both).
That endpoint needs the extra **Account → Access: Organizations, Identity Providers, and
Groups: Read** permission; when the token lacks it the endpoint is skipped (403 `[10000]`) and
setup falls back to an interactive prompt. For fully non-interactive runs, set
`SETUP_ACCESS_TEAM_DOMAIN`.

Set the token as an environment variable:

```bash
export CLOUDFLARE_API_TOKEN="your-token-here"
export CLOUDFLARE_ACCOUNT_ID="your-account-id-here"  # optional; setup can read it from wrangler
```

## Token vs interactive auth

`setup.mjs` authenticates Cloudflare API calls one of two ways:

- **API token (headless/CI and locals who prefer it):** set `CLOUDFLARE_API_TOKEN` (see scopes
  above). The script sends `Authorization: Bearer <token>` on every call. This is the
  authoritative path and the only one that works in headless mode.
- **Wrangler OAuth (interactive):** with no `CLOUDFLARE_API_TOKEN`, `setup.mjs` runs
  `wrangler login` in your browser. After login, wrangler stores OAuth credentials in its
  global config directory, resolved as `xdgAppPaths(".wrangler").config()` per the
  `xdg-portable` rules (honoring `XDG_CONFIG_HOME` on every OS):
  - Linux: `~/.config/.wrangler/config/default.toml`
  - macOS: `~/Library/Preferences/.wrangler/config/default.toml`
  - Windows: `%APPDATA%\xdg.config\.wrangler\config\default.toml` (`%APPDATA%` falls back
    to `~\AppData\Roaming`)
  - Legacy override kept by wrangler for backwards compatibility:
    `~/.wrangler/config/default.toml` on every OS (checked after the native path).

  The script reads the plaintext `oauth_token` from that file and uses it as the Bearer token
  for the REST API calls. (`WRANGLER_HOME` is not a wrangler environment variable and is not
  honored.)

Caveats:

- **`wrangler login --use-keyring` is not supported.** It stores the token encrypted in a
  `default.enc` file with the key in the OS keychain, which `setup.mjs` cannot read. If the
  script detects `default.enc` with no plaintext token, it fails fast with instructions:
  re-run `wrangler login --no-use-keyring` (plaintext), or set `CLOUDFLARE_API_TOKEN`.
- **API token is authoritative for Access (§13 of the product spec).** The token scopes above
  include _Access: Apps and Policies: Edit_. The OAuth path is a convenience for local runs;
  CI and anything scripted should use a scoped API token so failures are deterministic and
  don't depend on a browser.

## Provisioning

From the repo root:

```bash
npm install
npm run setup
```

This runs `setup.mjs` (or use `setup.sh` on Linux/macOS, `setup.ps1` on Windows). The script will:

1. Verify Node.js and Wrangler.
2. Use `CLOUDFLARE_API_TOKEN` if present; otherwise run `wrangler login` and reuse its OAuth
   token for the API calls (see "Token vs interactive auth").
3. Prompt for:
   - Worker domain (e.g. `pages.example.com`)
   - CDN / asset domain (e.g. `cdn.pages.example.com`)
   - Project name (used for resource names like `pagelively-assets`)
   - Admin email(s), comma-separated
   - Whether to create the optional KV namespace for JWKS caching
   - Zero Trust team domain (e.g. `yourteam.cloudflareaccess.com`) — only if it could not be
     resolved from `SETUP_ACCESS_TEAM_DOMAIN` or the Access organizations endpoint
4. Idempotently create the R2 bucket, D1 database, optional KV namespace, and Cloudflare Access application + policy. The Access application is created with an exact path scope of `{workerDomain}/admin` and `{workerDomain}/api` (primary `domain` = `{workerDomain}/admin`, `destinations` = `/admin` + `/api`), so **public content is never behind an Access prompt**. If an app named `{project} admin` already exists for the worker host but is not scoped to exactly those two paths (e.g. it was created with the bare hostname and currently prompts on every URL), setup repairs it **in place** with an update call — the app id and its `aud` tag are unchanged, so `ACCESS_AUD` in `wrangler.toml` keeps working.
5. Connect the R2 bucket to the CDN domain via the Cloudflare API.
6. Write the returned IDs, the CDN URL, and the Access `aud` / team domain into `wrangler.toml`.
7. Add a `[[routes]]` block for the Worker custom domain.
8. Apply D1 migrations (`wrangler d1 migrations apply --remote`).
9. Deploy (`wrangler deploy`).
10. Print the live URL, admin URL, and CDN URL.

## GitHub Actions deploy

Instead of running `npm run setup` locally, a human can trigger the manual-dispatch
`.github/workflows/deploy.yml` workflow from the GitHub UI (Actions → "Deploy Pagelively to
Cloudflare" → Run workflow). It runs `npm ci` + `npm run setup` headless with three repo
secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and `ADMIN_EMAILS`. The workflow
is never triggered by push or pull requests — deploying stays a human action with the
operator's own token. See the README quickstart for the token scopes, listed verbatim, and
`docs/adr/0030-s21-github-actions-deploy.md` for the headless setup design.

## Idempotency

Re-running is safe. The script lists existing resources by name and skips create calls for anything that already exists. If a previous run failed partway through, run it again and it will continue from where it left off. The one resource that can be **changed** on a re-run is the Access application: if it exists but protects the whole worker domain (the pre-2026-08-01 bug), setup fixes its scope to exactly `/admin` and `/api` in place — other resources are only ever created or skipped, never modified.

## After provisioning

- Your `wrangler.toml` now contains real resource IDs and URLs. **Do not commit it.** Keep it local.
- The admin dashboard is at `https://pages.example.com/admin`.
- Public pages are served at `https://pages.example.com/{slug}/` and `https://pages.example.com/p/{id}/`.
- Assets are served directly from `https://cdn.pages.example.com/pages/{id}/{rev}/...`.

## Troubleshooting

- **"Zone not found"**: add the Worker domain and the CDN domain to your Cloudflare account
  first. The zone lookup is an exact match, so a subdomain (e.g. `cdn.n.3a8r.com`) is resolved
  to its covering zone (`n.3a8r.com`, then `3a8r.com`) automatically; if none exists in the
  account, setup logs which domain could not be resolved and stops before deploying.
- **"R2 is not enabled on this Cloudflare account"** (error `[10042]`): enable R2 in the
  Cloudflare dashboard (R2 → Overview) and re-run.
- **"The Cloudflare API token is missing the D1 permission"** (error `[10000]` on the D1
  calls): add **Account → D1: Edit** to the token (not just Read) and re-run.
- **"Could not determine Access team domain"**: set `SETUP_ACCESS_TEAM_DOMAIN` and re-run, or
  add the optional "Access: Organizations, Identity Providers, and Groups: Read" permission so
  setup can resolve it automatically. Headless runs throw with the exact env var name.
- **"Zero Trust not initialized"**: complete the one-time Zero Trust setup above, then re-run.
- **D1 migration errors**: ensure the `wrangler.toml` `database_id` matches the provisioned database.
- **Custom domain not active**: DNS propagation can take a few minutes; `setup.mjs` does not wait for it.
- **"Failed to list Access apps (HTTP 400)… Authentication error"**: the API call went out
  unauthenticated — e.g. a stale or encrypted wrangler credential. Re-run `wrangler login
--no-use-keyring`, or set `CLOUDFLARE_API_TOKEN` and re-run.
- **"Found an encrypted wrangler OAuth credential…"**: you previously used `wrangler login
--use-keyring`; re-run `wrangler login --no-use-keyring` to store the token as plaintext.

## Next steps

After setup, run the operator smoke-test checklist in `docs/operations/smoke-test-checklist.md` against the real deployment.
