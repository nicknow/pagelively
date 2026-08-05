# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- Publishing a multi-file bundle whose entry is a Markdown file (e.g. multiple `.md` files, or
  a `.md` file alongside images/assets) stored the page's `entry_path` at the original upload
  path (e.g. `site/index.md`) instead of `index.html` — the path R2 actually stores the
  rendered entry under. Every such page 404'd when visited. `entry_path` now matches the stored
  object for bundle pages with a Markdown entry, consistent with the top-level `markdown` kind.

## [1.1.0] — Password protection & multi-domain support

### Added

- Per-page password protection (S23): admins can set or clear one password per page on create
  or edit (min 5 chars, max 256; empty = not protected). Visitors see a server-rendered
  password prompt; a successful unlock sets an opaque-token HttpOnly cookie (`pl_unlock`).
  Protected pages bypass the CDN — all entry HTML, image bytes, and assets are served by the
  Worker with `Cache-Control: no-store` and a Worker-origin `<base>` href. See ADR 0041 for
  the locked design decisions, OQ-19..OQ-24 for the open-questions log, and §10 of the roadmap
  for the full slice table.

### Fixed

- `setup.mjs` now detects and rejects deployments that would silently corrupt an existing
  deployment when run with the same projectName but different workerDomain/cdnDomain. A
  multi-domain collision guard (`checkDomainCollisions`) queries the real Cloudflare API to
  find existing Worker and R2 custom-domain associations before creating or modifying any
  resource, and aborts with an actionable error message when a collision is detected. An
  explicit opt-in override (`SETUP_ALLOW_REPOINT`) is available for deliberate repointing.
  See ADR 0044 for the detection heuristic and rationale.
- `setup.mjs` now rewrites the top-level `name` field in `wrangler.toml` so that the Worker
  script targets the correct name when deploying to multiple domains from the same checkout.
  A new `deriveWorkerName()` helper mirrors the existing `derive*Name` helpers.

### Changed

- CI process: switched to a `feature → development → main` branching workflow. Feature
  branches PR into `development` (the integration branch), and `main` only moves when a
  human deliberately promotes `development` into it for release. A CI workflow runs the
  full local gate (typecheck, lint, format:check, test) on PRs into `development`/`main`
  and pushes to `development`.

## [1.0.0] — v1 release

First stable release. The 0.1.0 build was deployed, exercised, and hardened with a few
post-deploy fixes that keep the one-command provision/deploy path reliable.

### Fixed

- Fragment/bookmark links in served HTML pages no longer 404. The injected `<base>` tag now
  points at the actual entry file (`.../{rev}/index.html`) so in-page anchors resolve to the
  real CDN object.
- GitHub Actions deploy workflow now passes the Zero Trust team domain to the headless setup
  script (`SETUP_ACCESS_TEAM_DOMAIN`), so the Access provisioning step can complete without
  interactive prompts.
- `setup.mjs` now writes the real D1 `database_name` into `wrangler.toml`, so `wrangler d1
migrations apply` finds the database on the first deploy.

## [0.1.0] — Initial public release

The first complete build: upload and publish HTML, Markdown, and image content (single files,
folders, or pasted text), served publicly by id or a friendly slug, with a buildless admin UI
protected by Cloudflare Access.

- Public serving: id/slug resolution, `<base>`-tag asset injection, immutable per-revision
  asset caching, edge-cached entry HTML, trailing-slash redirects, configurable home page.
- Content: HTML and Markdown pages (with raw-source download), image pages, multi-file/folder
  bundles, paste-to-publish for quick HTML/Markdown snippets.
- Admin: dashboard, upload (file picker + folder upload), edit (slug/title/visibility/show
  source), add/replace/delete files, delete page — all behind Cloudflare Access with
  independent JWT verification in the Worker.
- Deploy: one-command provisioning (`npm run setup`) that creates the R2 bucket, D1 database,
  optional KV namespace, Cloudflare Access application/policy, and both custom domains, then
  deploys — plus a manual-dispatch GitHub Actions workflow for the same flow.

See [`docs/adr/`](docs/adr/) for the detailed decision history behind this release.
