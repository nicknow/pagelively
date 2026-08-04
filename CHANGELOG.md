# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] — v1 release

First stable release. The 0.1.0 build was deployed, exercised, and hardened with a few
post-deploy fixes that keep the one-command provision/deploy path reliable.

### Added

- Per-page password protection (S23): admins can set or clear one password per page on create
  or edit (min 5 chars, max 256; empty = not protected). Visitors see a server-rendered
  password prompt; a successful unlock sets an opaque-token HttpOnly cookie (`pl_unlock`).
  Protected pages bypass the CDN — all entry HTML, image bytes, and assets are served by the
  Worker with `Cache-Control: no-store` and a Worker-origin `<base>` href. See ADR 0041 for
  the locked design decisions, OQ-19..OQ-24 for the open-questions log, and §10 of the roadmap
  for the full slice table.

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
