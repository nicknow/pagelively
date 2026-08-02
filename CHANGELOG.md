# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
