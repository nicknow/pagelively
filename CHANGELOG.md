# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
