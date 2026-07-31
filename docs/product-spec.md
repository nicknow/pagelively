# Spec: Self‑Hosted Static Content Publisher on Cloudflare

**Working name:** `pagelively` (deploy target example: `pages.acme.com`)
**Audience:** the single operator who deploys and uses the app

---

## 1. Overview

A single‑user application, deployed to your own Cloudflare account at zero cost, that lets
you upload HTML files, Markdown files, and images (individually or as bundles) and serve
them publicly by a short **id** or a friendly **slug**.

- **Public side:** files served statically from Cloudflare's CDN — free and unlimited
  bandwidth (§3). Anyone with the URL gets the file.
- **Private side:** you sign in and upload/manage content.
- **Deploy:** clone the repo (Linux or Windows 10/11), run one setup script, give it
  access to Cloudflare, and it provisions everything and goes live — including your
  custom domain. A GitHub Actions path is also provided.

### Goals
- Free to run on Cloudflare's free tiers for personal‑scale usage.
- One‑command setup that is idempotent (safe to re‑run).
- Uploads with accompanying images "just work" — relative references resolve after publish.
- Markdown is served as HTML, with the original Markdown optionally downloadable.

### Non‑goals (v1)
- Multi‑user / roles / sharing between accounts.
- A CMS with WYSIWYG editing. You upload finished files.
- Build pipelines for static‑site generators. (You can upload the *output* of one as a bundle.)

---

## 2. Architecture

*Note*: The use of actual domain names (FQDNs) such as `pages.acme.com`, `acme.com`, etc. are for clarity only. The actual FQDNs will need to be set as configuration values.

The app splits into two request paths so public traffic scales for free:

- **Worker** (`pages.acme.com`) — admin UI, uploads, Markdown rendering, and resolving a
  slug/id to a page's entry document. It's in the path only for the *entry* request.
- **R2 custom domain** (`cdn.pages.acme.com`) — serves the actual file bytes (images, CSS, JS,
  fonts, raw Markdown, and everything the entry references) straight from R2 via Cloudflare's
  CDN: cached, no egress fee, no Worker invocation. This is the "1 + 3" model (§3): aggressive
  edge caching plus direct‑from‑R2 serving.

All storage is on free tiers.

| Concern | Cloudflare service | Why |
|---|---|---|
| Compute / routing / rendering | **Workers** | The app itself; runs at the edge, deploys via Wrangler. |
| File bytes (html, md, images, css/js) | **R2** | Object storage, no egress fees, generous free tier. |
| Public byte serving (free, unlimited) | **R2 custom domain** (`cdn.pages.acme.com`) | Objects served directly by the CDN — cached, no egress, **not** counted as Worker requests. |
| Metadata (pages, slugs, file index) | **D1** (SQLite) | Relational lookups for slug→page, file listings. |
| Optional caching (e.g. Access public keys) | **KV** *(optional)* | Cache JWKS/etc. to cut lookups; the app works without it. |
| Custom domain (`pages.acme.com`) | **Workers custom domain** | Auto‑provisions the DNS record when `acme.com` is a zone in the same account. |
| Admin authentication | **Cloudflare Access** (Zero Trust) | Authenticates you at the edge before the Worker runs; no passwords in the app. |

**Why a Worker and not Cloudflare Pages static hosting:** content is uploaded at *runtime*,
not at build time. Pages' static hosting would require a redeploy per upload. A Worker with
R2 + D1 lets you add/remove content live without redeploying.

Deployment tool is **Wrangler** (Cloudflare's CLI), which runs on Linux and Windows and is
the only hard dependency besides Node.js.

---

## 3. Cost, caching & scaling (the 1 + 3 model)

Designed to stay free even if a page goes viral, by keeping the Worker out of the path for the
bulk of traffic:

- **Asset bytes are free and unlimited.** Images, CSS, JS, fonts, and raw Markdown are served
  by the R2 custom domain through Cloudflare's CDN. These requests are cached, incur no egress
  fee, and are **not counted as Worker requests** — the same property that lets Cloudflare
  Pages scale. A viral page's heavy bandwidth never touches the Worker.
- **The only metered public request is the entry document.** Opening a page makes one Worker
  request (resolve the slug, return the HTML); every asset it references then loads directly
  from the CDN. On the Workers **free** plan that's a ceiling of ~100,000 page‑opens/day (assets
  unlimited); on the **paid** plan ($5/mo) there's no cap and entry requests run ~$0.30 per
  million. Either way, bandwidth is free.
- **Aggressive edge caching** (the "1") means even repeat entry requests are served from the
  edge cache — no Markdown render, no D1 read, ~no CPU.

> **Verify current numbers before launch.** Free‑tier quotas change over time. Nothing here
> requires a paid tier for personal use; confirm live limits on Cloudflare's pricing pages.

Practical constraints the design already accounts for:
- **Upload size:** a Worker request body has an upper limit (on the order of ~100 MB on the
  free/pro plans — verify). Very large media should be resized before upload; multipart R2
  uploads are a future enhancement (§17).
- **Worker script size:** keep dependencies small (a compact Markdown renderer, no heavy
  frameworks) so the bundle stays within the free size limit.

---

## 4. Content model

The core unit is a **Page**. A Page is one thing you publish. It has a canonical **id**,
an optional **slug**, and one or more stored **files**.

**Page kinds:**
- `image` — a single image. The image *is* the page; visiting the URL returns the image bytes.
- `html` — an HTML document, optionally with accompanying asset files.
- `markdown` — a Markdown document rendered to HTML, optionally with accompanying images.
- `bundle` — a generalization: an entry document plus a folder of assets.

Every Page has one **entry** file (the thing served at the page root):
- image page → the image
- html page → the `.html`
- markdown page → the generated `index.html` (raw `.md` kept alongside)

**Identifiers:**
- **id** — short, generated, URL‑safe (e.g. 8–10 char nanoid). Always exists, never changes,
  guaranteed collision‑free. Canonical URL uses the id.
- **slug** — optional, human‑friendly, unique, editable. Derived from the filename/title on
  upload if you don't supply one. Validated against reserved words (§5).

Both point at the same Page. The id URL always works; the slug URL is a friendly alias.

---

## 5. URL & routing scheme

The whole domain is dedicated to the app, so public content can live at the root by slug.
A small set of prefixes is **reserved** and cannot be used as slugs.

Two hosts (§2): the **Worker** host `pages.acme.com` handles entry requests; the **CDN** host
`cdn.pages.acme.com` serves asset bytes directly from R2.

**Public — Worker host (`pages.acme.com`)**
- `GET /` → configurable home (§11): a designated page (by slug) or 404.
- `GET /{slug}/` → the page's entry document (served with asset URLs pointed at the CDN host — §6).
- `GET /p/{id}/` → the same, addressed by canonical id.
- `GET /{slug}` (no trailing slash) → **301** to `/{slug}/`.

**Public — CDN host (`cdn.pages.acme.com`)**
- `GET /pages/{id}/{rev}/{path...}` → an asset served straight from R2 (images, css, js, fonts,
  `source.md`). No Worker involved.

**Reserved prefixes / names** (rejected as slugs): `p`, `api`, `admin`, `_`, `assets`,
`favicon.ico`, `robots.txt`, `health`, `sitemap.xml`.

**Admin & API (protected by Cloudflare Access — see §9)**

Access authenticates these routes at the edge; there are **no in‑app login/logout
endpoints**. Sign‑out uses Access's own `/cdn-cgi/access/logout`.
- `GET /admin` → dashboard (Access shows its own login first if you're not signed in).
- `GET /api/pages` — list
- `POST /api/pages` — create (upload)
- `GET /api/pages/{id}` — details
- `PATCH /api/pages/{id}` — edit slug / title / visibility / show‑source
- `DELETE /api/pages/{id}` — delete page and its files
- `POST /api/pages/{id}/files` — add/replace files
- `DELETE /api/pages/{id}/files/{path}` — remove a file
- `GET /health` — liveness check

---

## 6. Image / asset reference resolution (the tricky part)

Requirement: when an HTML or Markdown file references images (or css/js), those references
must still resolve after publishing.

**Mechanism: a `<base>` tag points every relative reference at the page's folder on the CDN
host.** All files of a page live under one R2 prefix (`pages/{id}/{rev}/…`) served by the CDN
host. When the Worker returns the entry document, it injects:

```html
<base href="https://cdn.pages.acme.com/pages/{id}/{rev}/">
```

So a **relative** reference like `images/pic.png` or `./pic.png` resolves to
`https://cdn.pages.acme.com/pages/{id}/{rev}/images/pic.png` — served straight from R2 by the
CDN, bypassing the Worker. Because the base carries the per‑publish `{rev}`, updates never serve
stale assets (see caching, §11).

- **Folder uploads preserve structure.** Each file's relative path (e.g. `images/pic.png`) is
  kept as its stored path, so nested references work unchanged.
- For **Markdown**, the app controls the rendered output, so references are relative by
  construction and always resolve.
- **Single image / raw‑file pages** have no wrapping document; the Worker simply 301‑redirects
  the entry URL to the object on the CDN host.
- The `/{slug}` → `/{slug}/` redirect is still applied for clean URLs.

**Constraints:**
- Use **relative** references. **Root‑relative** references (`/images/pic.png`) resolve against
  the CDN host root, not the page folder, and won't find the asset.
- The injected `<base>` also makes relative *hyperlinks* resolve against the CDN host. For
  self‑contained content pages this is fine; if you hand‑author cross‑page links, use full
  paths. (Optional per‑page opt‑out is a future enhancement, §17.)

**Allowed asset types:** HTML pages commonly need CSS, JS, and fonts alongside images, so the
app serves any of these in a bundle with the correct content type. The whitelist ships with
images (png/jpg/jpeg/gif/webp/svg/avif), css, js, and common font formats, and is extensible.

---

## 7. Markdown handling

On upload of a `.md` file:
1. Store the raw Markdown in R2 as `source.md`.
2. Render it to HTML with a compact, Workers‑compatible renderer (e.g. `marked`).
3. Wrap the HTML in a minimal template (readable typography, responsive) that includes the
   `<base>` tag pointing at the page's CDN folder (§6). If **show source** is enabled, the
   template links to the raw file on the CDN host (`…/pages/{id}/{rev}/source.md`).
4. Store the result as `index.html` and set it as the entry.

- `raw_markdown_path` on the Page records where the original lives, so it's always
  retrievable even when not linked.
- **Raw HTML embedded inside Markdown:** allowed or stripped based on the
  `ALLOW_RAW_HTML_IN_MD` config flag. Because you author your own content, default is to
  allow; sanitize if you ever accept untrusted input.
- Rendering happens **at upload time** (deterministic, fast serving). A "re‑render all"
  admin action lets you apply template changes later without re‑uploading.

---

## 8. Storage schema

### R2 layout
Everything for a page is namespaced by id:

```
pages/{id}/{rev}/index.html        # entry (html or rendered markdown)
pages/{id}/{rev}/source.md         # original markdown (markdown pages only)
pages/{id}/{rev}/images/pic.png    # assets, original relative paths preserved
pages/{id}/{rev}/style.css
...
```
`{rev}` is a per‑publish revision counter. Republishing writes a fresh `{rev}` folder and flips
the pointer in D1, so cached assets are never stale and old revisions can be garbage‑collected
after a grace period.

### D1 tables

```sql
CREATE TABLE pages (
  id            TEXT PRIMARY KEY,      -- nanoid
  slug          TEXT UNIQUE,           -- nullable, friendly alias
  title         TEXT,
  kind          TEXT NOT NULL,         -- image|html|markdown|bundle
  rev           INTEGER NOT NULL DEFAULT 1,  -- publish revision (cache‑busting)
  entry_path    TEXT NOT NULL,         -- e.g. index.html
  raw_md_path   TEXT,                  -- e.g. source.md (nullable)
  show_source   INTEGER DEFAULT 0,     -- expose raw markdown (0/1)
  visibility    TEXT DEFAULT 'public', -- public|unlisted
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE files (
  page_id       TEXT NOT NULL,
  path          TEXT NOT NULL,         -- relative path within the bundle
  r2_key        TEXT NOT NULL,         -- pages/{id}/{rev}/{path}
  content_type  TEXT NOT NULL,
  size          INTEGER NOT NULL,
  PRIMARY KEY (page_id, path),
  FOREIGN KEY (page_id) REFERENCES pages(id) ON DELETE CASCADE
);

CREATE INDEX idx_pages_slug ON pages(slug);
```

`visibility = unlisted` means "not shown in any listing but reachable by URL." (There is no
public listing by default anyway; this is forward‑looking.)

---

## 9. Auth & security

Authentication is handled by **Cloudflare Access** (free Zero Trust). No passwords, sessions,
or login forms live in the app itself.

- **How it works:** an Access **application** protects `pages.acme.com/admin*` and
  `pages.acme.com/api/*`. A **policy** allows only your identity (email OTP by default, or a
  linked provider such as Google/GitHub). Access authenticates you at the edge *before* the
  Worker runs, so the admin surface is never exposed unauthenticated.
- **Public content is unaffected.** The Access application is scoped to the admin/api paths
  only; everything else (`/{slug}/…`, `/p/{id}/…`, `/health`) stays public.
- **Defense in depth in the Worker:** the Worker independently **verifies the Access JWT** on
  every admin/api request. Access injects a signed `Cf-Access-Jwt-Assertion` token; the Worker
  validates its signature against your team's public keys, checks the audience (`aud`) tag
  matches this app, and checks expiry — all via the Web Crypto API. Anything failing is
  rejected, so the admin API can't be reached even if the edge is somehow bypassed. The
  verified email is shown in the dashboard.
- **Sign‑out:** Access's own endpoint, `https://pages.acme.com/cdn-cgi/access/logout`.
- **Config the Worker needs:** `ACCESS_TEAM_DOMAIN` (e.g. `yourteam.cloudflareaccess.com`) and
  `ACCESS_AUD` (the application's AUD tag). Both are captured and written by setup (§13).
- **Free for up to 50 users;** you'll use one.
- **Public content** is served without auth. `unlisted` pages are reachable only by exact URL.

> **One‑time prerequisite:** your account must have Zero Trust initialized (you choose a team
> name → `yourteam.cloudflareaccess.com`). Setup automates the Access application and policy via
> the Cloudflare API when Zero Trust is already initialized; if it isn't, setup prints the
> one‑time steps and pauses.

---

## 10. Admin UI & upload flows

A minimal, buildless admin (server‑rendered HTML + a little vanilla JS — no framework needed,
keeps the Worker small). A small SPA is an optional upgrade.

The UI should reference the product' names: Pagelively.

**Dashboard:** list of pages (title, slug, id, kind, created date) with links to view, edit,
delete.

**Create / upload:**
- Drag‑and‑drop or file picker. Supports **multiple files** and **folder upload**
  (`<input webkitdirectory>`), which preserves relative paths for bundles.
- The client sends a small **manifest** (which file is the entry, each file's relative path)
  plus the file bytes as `multipart/form-data`. The Worker reads it via `request.formData()`.
- **Entry detection:** if exactly one `.html`/`.md` is present, it's the entry automatically.
  If ambiguous, you pick. A single image with no document → image page.
- You may set a slug (or accept the auto‑generated one) and, for Markdown, toggle **show source**.

**Edit:** change slug/title/visibility/show‑source; add or replace individual files; delete files.

**Delete:** removes the D1 rows and all `pages/{id}/…` objects from R2.

**Optional convenience:** accept a `.zip` bundle and expand it server‑side (needs a small zip
lib like `fflate`). Multi‑file/folder upload already covers most needs, so zip is optional (§16).

---

## 11. Public serving behavior

**Entry request (Worker host).** `GET pages.acme.com/{slug}/` (or `/p/{id}/`):
1. Resolve slug/id → page (`rev`, `entry_path`, kind) via D1.
2. For html/markdown pages, return the entry HTML with the `<base>` tag injected (§6). For
   image/raw pages, 301 to the object on the CDN host.
3. `text/html; charset=utf-8` for documents; correct MIME otherwise.

**Asset requests (CDN host).** `cdn.pages.acme.com/pages/{id}/{rev}/…` are served directly from
R2 by Cloudflare's CDN — no Worker, cached at the edge, no egress fee.

**Caching (the "1").**
- **Assets:** immutable. Because each URL carries `{rev}`, objects get
  `Cache-Control: public, max-age=31536000, immutable`; a republish changes `{rev}`, so URLs
  change and no cache purge is ever needed.
- **Entry HTML:** the Worker stores its response in the edge cache (Cache API) with a short
  `s-maxage` + `stale-while-revalidate`, so repeat opens skip D1/render/CPU. On publish/edit the
  Worker deletes just that page's cached entry, so updates appear immediately.
- **Admin/API:** `no-store`.

**Other behavior.**
- **Trailing slash:** `/{slug}` → 301 `/{slug}/`.
- **404:** a clean not‑found page for unknown slugs/ids/assets.
- **Home (`/`) — configurable** via `HOME_MODE` (optional setup value):
  - `page` → serve a designated page by slug (`HOME_PAGE_SLUG`).
  - `404` → return the not‑found page at root (the default when none is set).

---

## 12. Configuration

Set in `wrangler.toml` (`[vars]`) or as secrets; most are written by the setup script.

**Vars**
- `SITE_NAME` — display name in admin/templates.
- `ASSET_BASE_URL` — the CDN host serving R2 objects (e.g. `https://cdn.pages.acme.com`); used
  for the injected `<base>` tag and asset links.
- `HOME_MODE` — `page` | `404` (default `404`).
- `HOME_PAGE_SLUG` — used when `HOME_MODE=page`.
- `ALLOW_RAW_HTML_IN_MD` — allow raw HTML inside Markdown (default on).
- `PUBLIC_LISTING` — expose a public index of pages (default off).
- `ACCESS_TEAM_DOMAIN` — your Zero Trust team domain (e.g. `yourteam.cloudflareaccess.com`).
- `ACCESS_AUD` — the AUD tag of the Access application protecting admin/api.

**Secrets** (never in the repo)
- None required for auth — Cloudflare Access handles it. (Reserved for future integrations.)

**Bindings** (in `wrangler.toml`): the R2 bucket, D1 database, and optional KV namespace, plus
`routes = [{ pattern = "pages.acme.com", custom_domain = true }]` for the Worker host. The R2
bucket is separately exposed for public reads via its own custom domain (`cdn.pages.acme.com`),
configured in setup (§13) rather than through `wrangler.toml`.

---

## 13. Deployment & setup

**One prerequisite: Node.js** (Wrangler needs it, and the setup script is a Node script so it
runs identically on Linux and Windows — no WSL required). Install instructions for both OSes
ship in the README.

### Local one‑command setup
`npm install` then `npm run setup` runs `setup.mjs`, which:
1. Verifies Node and installs Wrangler (as a dev dependency, via `npx`).
2. Authenticates to Cloudflare — `wrangler login` (opens a browser) for local use, or uses a
   `CLOUDFLARE_API_TOKEN` if present (for headless/CI).
3. Prompts for: the Worker domain (`pages.acme.com`), the CDN/asset domain
   (`cdn.pages.acme.com`), the project name, and the email(s) allowed to reach the admin (for
   the Cloudflare Access policy).
4. **Idempotently** creates resources, skipping any that already exist:
   `wrangler r2 bucket create`, `wrangler d1 create`, `wrangler kv namespace create`.
5. Writes the returned resource IDs into `wrangler.toml` (or a generated overlay file).
6. Applies D1 migrations: `wrangler d1 migrations apply`.
7. Configures **Cloudflare Access** via the Cloudflare API: idempotently creates an Access
   application over `pages.acme.com/admin*` and `/api/*` plus a policy allowing your email(s),
   then captures the application's **AUD** tag and team domain and writes them as vars
   (`ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`). If Zero Trust isn't initialized yet, it prints the
   one‑time steps and pauses.
8. Configures the Worker custom domain in `wrangler.toml` (the `custom_domain` route
   auto‑creates the DNS record on deploy, because `acme.com` is a zone in the same account).
9. Connects the **R2 bucket to the CDN domain** (`cdn.pages.acme.com`) for public reads via the
   Cloudflare API, and writes `ASSET_BASE_URL`. This is the path that serves asset bytes free
   and unlimited.
10. `wrangler deploy`.
11. Prints the live URL, the CDN URL, and the admin URL.

Thin wrappers `setup.sh` (Linux) and `setup.ps1` (Windows PowerShell) simply call
`node setup.mjs` for people who prefer a native entry point. Re‑running is safe.

### GitHub path
Two supported styles:
- **GitHub Actions deploy:** fork/clone, add repo secrets (`CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID`, and `ADMIN_EMAILS` for the Access policy), then run a
  manual‑dispatch `deploy.yml` workflow that provisions + deploys with Wrangler.
- **Codespaces / any dev container:** run the same `npm run setup` in a cloud dev environment.

### Required Cloudflare API token scopes (for token/CI auth)
When not using interactive `wrangler login`, mint a token with:
- **Account** → Workers Scripts: *Edit*, Workers R2 Storage: *Edit*, D1: *Edit*,
  Workers KV Storage: *Edit* (if KV used), Access: Apps and Policies: *Edit* (to create the
  Access application + policy), Account Settings: *Read*.
- **Zone** (for the target zone) → DNS: *Edit* (for both the Worker and R2/CDN records),
  Workers Routes: *Edit* (to attach the Worker custom domain).

The README will list these explicitly so token creation is copy‑paste.

---

## 14. Suggested repo structure & tech choices

```
/                 wrangler.toml, package.json, README
/src              Worker code (router, admin, api, public serving, md render)
/src/public       minimal admin HTML/CSS/JS (server‑rendered or static assets)
/migrations       D1 SQL migrations
setup.mjs         cross‑platform provisioning + deploy script
setup.sh / setup.ps1   thin wrappers
.github/workflows/deploy.yml
```

- **Runtime:** Workers, TypeScript.
- **Markdown:** `marked` (compact, pure JS). Optional sanitizer if you accept untrusted input.
- **IDs:** `nanoid` (or Web Crypto random).
- **Access JWT verification:** Web Crypto (validate signature / `aud` / expiry) — no native crypto deps.
- **No frontend framework required** for v1 (keeps the bundle small and buildless).

---

## 15. Limits & constraints to design around

- **Public bandwidth is free and unlimited** — asset bytes come from the R2 CDN host, not the
  Worker (§3). The only metered public request is the entry document (~100k/day on the free
  plan; uncapped and ~$0.30/M on paid).
- **Upload request body limit** (~100 MB on free/pro) applies to the Worker upload path only,
  not to public serving. Resize very large media before upload; multipart R2 upload is future
  (§17).
- Per‑request Worker CPU limits — resolving a page and rendering Markdown are well within them;
  cached entry hits use ~none.
- Worker script size limit — keep dependencies lean.
- Both custom domains (Worker + CDN) require `acme.com` to be a zone in the same account.
- Verify current free‑tier quotas before launch.

---

## 16. Resolved decisions

1. **Home page (`/`):** optional setup value — serve a designated slug (`HOME_MODE=page` +
   `HOME_PAGE_SLUG`) or return 404 (`HOME_MODE=404`, the default).
2. **Asset types:** CSS, JS, and fonts are allowed in bundles alongside images (extensible
   whitelist).
3. **Auth:** Cloudflare Access from the start; no in‑app passwords (§9).
4. **URLs:** root‑level slugs (`pages.acme.com/my-post`), with the reserved prefixes in §5.
5. **Serving model:** "1 + 3" — aggressive edge caching plus asset bytes served directly from R2
   via a CDN custom domain (`cdn.pages.acme.com`), keeping the Worker out of the hot path so
   public bandwidth is free and unlimited (§2, §3, §6, §11).

Still deferred to later (not blocking v1): server‑side **zip** upload (folder/multi‑file covers
v1), and an optional **public listing** at `/` (off by default).

---

## 17. Future enhancements

- Root‑relative link rewriting for HTML (inject `<base>` or rewrite `/…` refs to the page prefix).
- Multipart R2 uploads for large media; client‑side image resizing.
- Per‑page password / expiry / basic analytics.
- Optional public index / tags / search.
- Optional SPA admin with a nicer editor and drag‑to‑reorder.
- "Re‑render all Markdown" after template changes; theme selection.
