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

- **Account** → Workers Scripts: _Edit_, Workers R2 Storage: _Edit_, D1: _Edit_, Workers KV Storage: _Edit_ (if KV is used), Access: Apps and Policies: _Edit_, Account Settings: _Read_.
- **Zone** (for your target domain) → DNS: _Edit_, Workers Routes: _Edit_.

Set the token as an environment variable:

```bash
export CLOUDFLARE_API_TOKEN="your-token-here"
export CLOUDFLARE_ACCOUNT_ID="your-account-id-here"  # optional; setup can read it from wrangler
```

## Provisioning

From the repo root:

```bash
npm install
npm run setup
```

This runs `setup.mjs` (or use `setup.sh` on Linux/macOS, `setup.ps1` on Windows). The script will:

1. Verify Node.js and Wrangler.
2. Use `CLOUDFLARE_API_TOKEN` if present; otherwise prompt for `wrangler login`.
3. Prompt for:
   - Worker domain (e.g. `pages.example.com`)
   - CDN / asset domain (e.g. `cdn.pages.example.com`)
   - Project name (used for resource names like `pagelively-assets`)
   - Admin email(s), comma-separated
   - Whether to create the optional KV namespace for JWKS caching
4. Idempotently create the R2 bucket, D1 database, optional KV namespace, and Cloudflare Access application + policy.
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

Re-running is safe. The script lists existing resources by name and skips create calls for anything that already exists. If a previous run failed partway through, run it again and it will continue from where it left off.

## After provisioning

- Your `wrangler.toml` now contains real resource IDs and URLs. **Do not commit it.** Keep it local.
- The admin dashboard is at `https://pages.example.com/admin`.
- Public pages are served at `https://pages.example.com/{slug}/` and `https://pages.example.com/p/{id}/`.
- Assets are served directly from `https://cdn.pages.example.com/pages/{id}/{rev}/...`.

## Troubleshooting

- **"Zone not found"**: add the Worker domain and the CDN domain to your Cloudflare account first.
- **"Zero Trust not initialized"**: complete the one-time Zero Trust setup above, then re-run.
- **D1 migration errors**: ensure the `wrangler.toml` `database_id` matches the provisioned database.
- **Custom domain not active**: DNS propagation can take a few minutes; `setup.mjs` does not wait for it.

## Next steps

After setup, run the operator smoke-test checklist in `docs/operations/smoke-test-checklist.md` against the real deployment.
