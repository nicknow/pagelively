# 0030: S21 — GitHub Actions deploy workflow and headless setup

- Status: accepted
- Date: 2026-08-01

## Context

`docs/product-spec.md` §13 ("GitHub path") requires a manual-dispatch GitHub Actions workflow that runs `npm ci` + `npm run setup` against the operator's Cloudflare credentials, and a README quickstart that documents the Node.js prerequisite and the API token scopes verbatim.

The S20 `setup.mjs` script is fully **interactive**: it prompts for the worker/CDN domains, project name, admin emails, and the KV choice; falls back to interactive `wrangler login` when no token is present; and pauses (readline) when Zero Trust is not initialized. CI cannot prompt, cannot open a browser, and cannot pause — so the same script needed a headless mode with deterministic failure, plus a workflow that wires every value in.

## Decision

1. **Manual-dispatch workflow (`.github/workflows/deploy.yml`).** `on.workflow_dispatch` only, with four inputs (`worker-domain`, `cdn-domain`, `project-name`, `create-kv`) and the repo secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ADMIN_EMAILS`. Job `ubuntu-latest`: checkout → `actions/setup-node@v4` (`node-version: 22`, `cache: npm`) → `npm ci` → `npm run setup` with the three secrets, the four `SETUP_*`/inputs mappings, and `SETUP_NON_INTERACTIVE: '1'`. It is **never** triggered by push/PR: deploying stays a human-triggered action using the operator's own token, and the build team never touches Cloudflare.

2. **Headless env-override design in `setup.mjs`.** New exported helpers, unit-tested:
   - `parseTruthy(value)` — `1|true|yes` (trimmed, case-insensitive) → `true`; any other defined value → `false`; `undefined|null|""` → `undefined` (treated as unset).
   - `envToSetupOptions(env)` — maps `SETUP_WORKER_DOMAIN` → `workerDomain`, `SETUP_CDN_DOMAIN` → `cdnDomain`, `SETUP_PROJECT_NAME` → `projectName`, `ADMIN_EMAILS` → `adminEmails`, `SETUP_CREATE_KV` → `createKv`, `SETUP_NON_INTERACTIVE` → `headless`. `main()` calls `runSetup(envToSetupOptions(process.env), deps)`; interactive humans still get every prompt.
   - Inside `runSetup`, headless mode swaps in non-interactive `prompt`/`confirm`/`pause` implementations: prompt returns its provided default or throws an error naming the missing value (via a fixed prompt→env-var map, e.g. "Missing required value: admin email(s). Set the ADMIN_EMAILS environment variable…"); confirm returns its default; the Zero Trust pause path prints the one-time setup steps and then throws an actionable error (copyable to the operator) instead of pausing. A missing `CLOUDFLARE_API_TOKEN` throws before any `wrangler login`.

3. **CI still runs setup with the operator's token.** The workflow passes `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID`/`ADMIN_EMAILS` from repo secrets into the headless run. Nothing about provisioning moved into build CI.

4. **Workflow contract is tested.** `test/github-actions.test.ts` (new `yaml` devDependency) imports the committed `.github/workflows/deploy.yml` via a Vite `?raw` import (the workerd test runtime has no filesystem access) and asserts: `on.workflow_dispatch` with the four inputs and defaults, `actions/setup-node@v4` with Node 22 + npm cache, `npm ci` before `npm run setup`, the setup step's env containing the three `${{ secrets... }}` expressions, the four inputs mappings, and `SETUP_NON_INTERACTIVE: '1'` — plus that the `${{ secrets... }}` expressions appear verbatim in the committed file.

## Citations

- `workflow_dispatch` trigger and inputs: `docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#workflow_dispatch`.
- `actions/setup-node` (Node 22, npm cache): `github.com/actions/setup-node`.
- Repo secrets in workflows: `docs.github.com/en/actions/security-guides/using-secrets-in-github-actions`.
- Token scopes for headless/CI auth: `docs/product-spec.md` §13 "Required Cloudflare API token scopes".

## Consequences

- Interactive mode is byte-for-byte unchanged: the 38 existing `setup.mjs` tests pass unmodified; 11 headless tests added in `test/setup-headless.test.ts`, 5 YAML tests in `test/github-actions.test.ts`.
- Headless failures are deterministic and actionable (missing token, missing `ADMIN_EMAILS`, Zero Trust not initialized), which is what a human-triggered CI run needs.
- **Known limitation:** the pre-deploy "zone not found" path still logs an error and returns (exit 0) rather than throwing, even headless. The S21 criteria only mandate the Zero Trust path to throw; hardening that path is a candidate for a later slice.
- `setup.d.mts` grew `parseTruthy`/`envToSetupOptions` declarations so the test typecheck covers them.
- The workflow requires three repo secrets to exist before the first run; README reproduces the §13 scopes verbatim for copy-paste token creation.
