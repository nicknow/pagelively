# Changelog

All notable changes to this project are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.4.0] — Raw Markdown hosting

### Added

- **Raw Markdown pages** — a new `raw-markdown` page kind publishes a `.md`/`.markdown` file
  verbatim with no HTML conversion: no rendering, no template, no `index.html`. The file is
  stored as a single `source.md` object with content type `text/plain; charset=utf-8`, so
  visiting the slug/id URL redirects to the CDN object and the browser displays the raw
  Markdown as text. Available on both upload and paste tabs; the dashboard shows a dedicated
  kind badge and the edit page hides the show-source control (the page *is* the source).
  Password-protected raw pages are streamed by the Worker with `Cache-Control: no-store`,
  never exposing the CDN URL. Mode switching between rendered and raw is explicitly not
  supported. See ADR 0054.

## [1.3.0] — Markdown template system with dark mode

### Added

- **Markdown template system** — public Markdown pages now render through a full HTML template
  with readable typography, responsive layout, and automatic dark mode via
  `@media (prefers-color-scheme: dark)` (no JavaScript). Templates live in a new
  `src/templates/` module behind an extensible registry; unknown template names fall back to
  the `"default"` template rather than failing. `MarkdownRenderOptions` gains an internal
  `template?: string` field, laying the groundwork for future per-page theme selection without
  requiring a migration today. The `<base>`-injection, `{{CONTENT}}` slot, `showSource`, and
  raw-HTML contracts are all unchanged. See ADR 0053.

### Changed

- **Edit form save confirmation** — saving page metadata now shows a green "Page updated."
  success toast, then reloads after a 1.5-second delay, instead of reloading immediately. The
  error path is unchanged.

## [1.2.0] — Tags, listing pages, settings, and UI polish

### Added

- **Tags** — pages can have zero or more tags (comma-separated labels). Tags are set on upload
  or edit, stored in a junction table, and accessible via the admin API. See the
  [user guide](docs/guide/README.md#tags).
- **Listing pages** — a special page kind that dynamically renders a list of all public pages
  matching ALL configured tags. Listing pages are created by selecting "Listing page" from the
  Page kind selector on upload or paste forms. See the [user guide](docs/guide/README.md#listing-pages).
- **Settings** — a new `/admin/settings` page lets operators configure a default page slug
  served at the root URL, overriding env-var-based configuration. Managed via
  `GET/PATCH /api/settings`.
- **AI guidance** — a new section in the README tells AI agents how to create
  Pagelively-compatible content (relative paths, inline CSS, self-contained bundles).

### Changed

- **Back navigation** — on edit and upload pages, the Back/Cancel buttons have moved from the
  bottom form toolbar to a top-left navigation bar with an arrow icon, matching common web app
  patterns.
- **Date formatting** — dashboard dates now render in `<time datetime="...">` elements and are
  formatted client-side using `Intl.DateTimeFormat` with the user's browser locale, instead of
  raw ISO-8601 strings.

### Fixed

- Publishing a multi-file bundle whose entry is a Markdown file (e.g. multiple `.md` files, or
  a `.md` file alongside images/assets) stored the page's `entry_path` at the original upload
  path (e.g. `site/index.md`) instead of `index.html` — the path R2 actually stores the
  rendered entry under. Every such page 404'd when visited. `entry_path` now matches the stored
  object for bundle pages with a Markdown entry, consistent with the top-level `markdown` kind.
- Tags on a page were not persisted across page reloads on the edit form — the tags input now
  pre-fills with existing tags from the database.
- Listing pages returned a 404 when visited because the serving logic tried to read the entry
  HTML from R2 before checking the page kind. Listing pages (which have no uploaded files) now
  render before the R2 lookup occurs.
- Listing pages matched pages having ANY of the configured tags instead of ALL. The SQL query
  now uses `GROUP BY … HAVING COUNT(DISTINCT tag) = n` to require all specified tags.
- `parseTags()` was scoped inside the upload page's inline script and unavailable to the edit
  page, causing a `ReferenceError` when saving tags on the edit form. Moved to the shared
  `SHARED_JS` block.
- A duplicate `const isPasteListing` declaration in the paste form submit handler would throw a
  `SyntaxError` on paste form submission. Removed the re-declaration.

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
