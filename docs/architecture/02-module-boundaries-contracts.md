# 02 — Module boundaries & contracts

The Worker is a small, hand-rolled router over pure functions + thin binding adapters
(ADR 0002: no router library, deps are `marked` + `jose` only). This document fixes the module
boundaries and the TypeScript-facing contracts — the interfaces tests assert against and the
implementer builds to. **The spec's §14 repo structure is authoritative; this refines it.**

## Directory layout (target)

```
src/
  index.ts            entry handler: dispatch + error boundary (single try/catch)
  router.ts           classifyPath() + route table (pure)
  config.ts           typed, validated config accessor over Env (normalizes vars)
  errors.ts           AppError taxonomy + toErrorResponse() (ADR 0005)
  ids.ts              generateId()/validateId() — Web Crypto, URL-safe (§4)
  slug.ts             slugify(), validateSlug() — reserved-word check (S02, ADR 0011), collision suffixes (ADR 0007)
  rev.ts              nextRev(), shouldBumpRev(), buildR2Key() (ADR 0006, 0012)
  content-type.ts     MIME table (§6 whitelist + .md/.html; extensible data)
  cache-headers.ts    headersFor(routeClass, pageId?) — pure cache policy (ADR 0006, 0016)
  markdown.ts         renderMarkdown(md, opts) via marked + custom html renderer (§7);
                      minimal responsive HTML template is inline (no separate template.ts)
  base-inject.ts      injectBase(html, baseHref) — serve-time, first element of first real
                      <head>; <head> created if absent; existing <base> removed; never
                      throws; href escaped + trailing-slash normalized (ADR 0008, 0013)
  redirects.ts        trailing-slash + image/raw 301 helpers (pure)
  home.ts             home-mode resolution (pure)
  entry-serve.ts      entry pipeline: resolve → read → inject base → respond
  cache-service.ts    CacheService — headers + purge adapter (the cache seam, ADR 0009)
  pages-repository.ts D1: pages rows (reads/writes)
  files-repository.ts D1: files rows (reads/writes)
  object-store.ts     R2: put/get/delete/list under pages/{id}/{rev} (§8 layout)
  access-verify.ts    JWT gate: verifyAccessJwt(request, deps) (ADR 0005, OQ-12)
  jwks-provider.ts    JwksProvider: remote (createRemoteJWKSet) + KV cache impls
  form-parser.ts      multipart parsing + 95 MB guard + manifest validation (S17)
  admin-api.ts        /api/* handlers (list, create, patch, delete, files)
  admin-ui.ts         /admin dashboard HTML (buildless, §10)
  health.ts           /health
  utils.ts            escapeHtml(value) — & < > " ' → entities (first consumer: base-inject.ts, S04); isoDate, etc.

test/                 slice tests (see 06)
```

Modules are grouped by **dependency direction**: `router/config/errors/ids/slug/rev/
content-type/cache-headers/markdown/base-inject/redirects/home/utils` are pure (no
bindings, fully unit-tested); `*-repository/object-store` are binding adapters (D1/R2);
`entry-serve/admin-api/admin-ui/health` are handlers; `cache-service/access-verify/
jwks-provider` are seams with injectable dependencies.

## Environment contract

`Env` comes from `worker-configuration.d.ts` (`npm run types`, committed — ADR 0001). The
Worker reads config only through `config.ts`, which normalizes and validates vars once:

```ts
interface Env {
  BUCKET: R2Bucket;
  DB: D1Database;
  KV?: KVNamespace; // optional — Worker must work without it (§2)
  SITE_NAME: string;
  ASSET_BASE_URL: string; // e.g. https://cdn.pages.acme.com (§12)
  HOME_MODE: "page" | "404";
  HOME_PAGE_SLUG: string;
  ALLOW_RAW_HTML_IN_MD: string; // "true" | "false" (§7, §12)
  PUBLIC_LISTING: string; // reserved for future (§16) — no v1 behavior
  ACCESS_TEAM_DOMAIN: string; // bare domain, e.g. yourteam.cloudflareaccess.com (OQ-12)
  ACCESS_AUD: string; // Access application AUD tag (§9)
}

interface AppConfig {
  siteName: string;
  assetBaseUrl: string; // validated http(s) URL, no trailing slash
  homeMode: "page" | "404";
  homePageSlug: string | null;
  allowRawHtmlInMd: boolean;
  access: { teamDomainUrl: string; aud: string | null }; // teamDomainUrl = https://{bare}
}
```

`access.aud === null` (unset/placeholder) ⇒ the JWT gate fails closed on every request
(ADR 0005; S16 AC). `ACCESS_TEAM_DOMAIN` is stored bare per OQ-12; `config.ts` strips any
scheme/trailing slash defensively and prepends `https://`.

## Domain model (shared types)

```ts
type PageKind = "image" | "html" | "markdown" | "bundle"; // §4
type Visibility = "public" | "unlisted"; // §8 (forward-looking)
type CacheRouteClass =
  | "entry" // /{slug}/, /p/{id}/, home page
  | "redirect" // 301 image/raw → CDN object
  | "asset" // R2 CDN-served object
  | "admin" // admin UI + API
  | "notFound" // clean 404
  | "error"; // generic 500

interface PageRecord {
  id: string; // nanoid-style, 8–10 URL-safe chars (ids.ts)
  slug: string | null; // unique, lowercase, reserved-checked (ADR 0007)
  title: string;
  kind: PageKind;
  rev: number; // per-publish revision (ADR 0006)
  entry_path: string; // "index.html" for document kinds; the file name for image/raw
  raw_md_path: string | null; // "source.md" for markdown entries (incl. bundle w/ md entry)
  show_source: 0 | 1;
  visibility: Visibility;
  created_at: string; // ISO-8601 UTC
  updated_at: string;
}

interface FileRecord {
  page_id: string;
  path: string; // relative path within the bundle, e.g. images/pic.png (§6)
  r2_key: string; // pages/{id}/{rev}/{path} (§8) — embeds rev
  content_type: string;
  size: number;
}

// R2 keys are built only through rev.ts (spec §8 layout is a hard contract):
function buildR2Key(pageId: string, rev: number, path: string): string; // "pages/{id}/{rev}/{path}"
function nextRev(current: number): number; // +1
function shouldBumpRev(action: RevAction): boolean; // ADR 0006 table, concretized by ADR 0012

// RevAction — closed discriminated union (ADR 0012); anything else throws.
type RevAction =
  | { type: "file-add" } // add/replace a file — bumps
  | { type: "file-delete" } // bumps
  | { type: "entry-change" } // entry content changed — bumps
  | { type: "re-render" } // markdown re-render — bumps
  | { type: "slug-edit" } // metadata — no bump (ADR 0012 reconciliation)
  | { type: "meta-edit" } // title/visibility/show_source — no bump
  | { type: "create" }; // rev starts at 1 (§8 DEFAULT 1)

// Fail-fast (typed AppError, never raw): invalid rev → "invalid_rev"/500;
// unknown action → "unknown_action"/500; escaping/absolute/empty path in
// buildR2Key → "path_traversal"/400. Path normalization: `//` and `./` drop,
// trailing slashes strip, non-escaping `..` pops; input is an already-decoded
// string (`%`-sequences and `\` are literal). Details: ADR 0012.
```

## Router contract (pure)

```ts
type Route =
  | { type: "home" }
  | { type: "health" }
  | { type: "slug"; slug: string } // /{slug} or /{slug}/
  | { type: "id"; id: string } // /p/{id}/…
  | { type: "admin" } // /admin…  (Access-protected at edge)
  | { type: "api" } // /api/*    (Access-protected at edge)
  | { type: "unknown" };

function classifyPath(pathname: string): Route;
```

Rules (spec §5): root → `home`; `/health` → `health` (never redirected); `/p/{id}` → `id`;
`/{slug}` → `slug`; `/admin` → `admin`; `/api/...` → `api`; everything else → `unknown`
(clean 404). Trailing-slash handling is a separate pure step (`redirects.ts`): `/{slug}` →
301 `/{slug}/`, `/p/{id}` → 301 `/p/{id}/`, never on root/health, no loops on encoded
slashes (S08 AC). Malformed paths never throw.

## Redirects contract (pure)

```ts
function trailingSlashRedirect(route: Route, url: URL, method?: string): Response | null;
function clean404Response(url: URL): Response;
```

- `trailingSlashRedirect` returns a 301 `Response` only when `route.type` is `"slug"` or
  `"id"` **and** `url.pathname` does not end with `/`. The `Location` header is the full
  absolute URL with a trailing slash appended to the pathname, preserving scheme, host,
  port, query string, and hash. For all other routes and already-slash-terminated paths,
  it returns `null` so the caller can handle the route directly (S08). The body is empty;
  no `Cache-Control` is attached here (S08 ADR 0017).
- `clean404Response` returns a 404 HTML `Response` with `Content-Type: text/html;
 charset=utf-8` and `Cache-Control: no-store` (via `headersFor("notFound")`, S07). The body
  is a minimal HTML document with `<title>Not Found</title>` and the _decoded_ request
  pathname, HTML-escaped. It never leaks stack traces or internal details.

## Home resolution contract (pure)

```ts
type HomeResolution = { type: "page"; slug: string } | { type: "404" };

function resolveHome(
  homeMode: string | null | undefined,
  homePageSlug: string | null | undefined,
): HomeResolution;
```

- `resolveHome` is total and fail-safe: every input maps to the closed union above.
- `homeMode` is normalized by trimming whitespace and lowercasing. Only the value `"page"`
  produces a page decision; all other values (including `"404"`, empty, null, undefined,
  whitespace-only, or garbage) produce `{ type: "404" }` (S09, ADR 0018).
- When `homeMode` resolves to `"page"`, `homePageSlug` is validated by `validateSlug` from
  S02. A missing, empty, or invalid slug (reserved word, wrong charset, too long, etc.)
  produces `{ type: "404" }`. The specific `AppError` from `validateSlug` is not exposed.
- On success, the function returns the slug as provided. S12 treats this as a synthetic slug
  route and serves the same entry HTML at `/` that it would serve at `/{slug}/` (direct
  serve, no redirect — OQ-08, ADR 0018).
- The function does not query D1, build a `Response`, or emit cache headers. If the
  resolved slug does not exist at serve time, S12 produces a `clean404Response` (S08).

## Repository contracts (D1)

```ts
interface PagesRepository {
  getById(id: string): Promise<PageRecord | null>;
  getBySlug(slug: string): Promise<PageRecord | null>; // uses idx_pages_slug
  list(): Promise<PageRecord[]>; // admin-only, created_at DESC
  create(p: NewPage): Promise<PageRecord>;
  updateMeta(id: string, patch: MetaPatch): Promise<PageRecord | null>; // no rev bump
  applyRevBump(
    id: string,
    rev: number,
    entryPath: string,
    rawMdPath: string | null,
  ): Promise<PageRecord | null>;
  delete(id: string): Promise<boolean>; // files cascade (§8)
  slugTaken(slug: string, exceptId?: string): Promise<boolean>;
}

interface FilesRepository {
  replaceAll(pageId: string, rev: number, files: NewFile[]): Promise<void>; // delete+insert
  deleteFile(pageId: string, path: string): Promise<boolean>;
  listForPage(pageId: string): Promise<FileRecord[]>;
}
```

Query discipline (S10 AC, R4): `getBySlug`/`getById` are index-covered; `list` is a plain scan
of a small, admin-only table (no extra index on `created_at` — an index adds a written row per
insert on a hot column for no read win at personal scale; verified D1 pricing note: indexes add
a written row). Mutations run in a D1 batch where atomicity matters (create page + files rows).

## Object store contract (R2)

```ts
interface ObjectStore {
  put(
    pageId: string,
    rev: number,
    path: string,
    body: ArrayBuffer | ReadableStream,
    contentType: string,
  ): Promise<void>; // httpMetadata: content_type + immutable Cache-Control
  get(
    pageId: string,
    rev: number,
    path: string,
  ): Promise<{ body: ReadableStream; contentType: string; size: number } | null>;
  deletePageObjects(pageId: string): Promise<void>; // all revs, paginated list+delete
}
```

Key layout is a hard contract (spec §8, coding standards): `pages/{id}/{rev}/{path}` — never
invent a parallel layout. Folder uploads preserve relative paths (§6). Missing object → `null`.

## Cache seam (the testable contract — ADR 0009)

Workers Caching purge/HITs are **not emulated** by the local pool (spike evidence; ADR 0009).
Handlers therefore depend on this interface, never on `ctx.cache` directly:

```ts
interface CacheService {
  // The pure function accepts all CacheRouteClass values; the seam may be
  // narrower in practice, but it delegates to the same `headersFor` impl.
  headersFor(routeClass: CacheRouteClass, pageId?: string): Headers;
  purgePage(ctx: ExecutionContext, pageId: string): Promise<void>; // { tags: [`page-${id}`] }
  purgePages(ctx: ExecutionContext, ids: string[]): Promise<void>; // batched
}
```

- Production impl (`createCacheService(env)`): wraps `ctx.cache.purge({ tags: [...] })` — the
  documented purge-after-write pattern; purge failures are logged and **non-fatal** (mutation
  already committed; S13 AC).
- Test impl: a recording fake asserted for call shape (tags, timing, absence on read-only ops).
- `headersFor` is pure (`src/cache-headers.ts`) and fully unit-tested (S07 AC). It returns a
  fresh `Headers` object: entry/redirect get `Cache-Control: public, max-age=300,
stale-while-revalidate=3600` + `Cache-Tag: page-{id}`; asset gets `public, max-age=31536000,
immutable`; admin, notFound, and error get `no-store`. The function never emits
  `s-maxage`, `must-revalidate`, `proxy-revalidate`, or `private`.
- Live purge/HIT verification → operator smoke-test checklist (06, S22).

## JWT verification seam (ADR 0005, OQ-12)

```ts
interface JwksProvider {
  getKey(jwt: string): Promise<CryptoKey | undefined>; // key lookup by kid
}
interface AccessVerifier {
  verify(request: Request): Promise<VerifiedIdentity | null>; // null ⇒ 403, fail closed
}
interface VerifiedIdentity {
  email: string | null;
} // §9 dashboard display
```

- Production: `jose`'s `createRemoteJWKSet(new URL(`${teamDomainUrl}/cdn-cgi/access/certs`))`
  - `jwtVerify(token, JWKS, { issuer: teamDomainUrl, audience: aud })` — the official pattern
    (verified docs). Claims: `iss` = `https://{ACCESS_TEAM_DOMAIN}`, `aud` = `ACCESS_AUD`,
    `exp` checked by jose (±60 s clock skew), `kid` from JWKS.
- KV cache (optional binding): `JwksProvider` wrapper storing `{ keys }` under key
  `access-jwks` with `expirationTtl: 3600` (1 h); refetch on miss/stale/corrupt; write
  failures ignored; absent KV → fetch every time; fetch failure → `null` ⇒ fail closed (S14 AC).
- Tests: `createLocalJWKSet(jwks)` with locally generated RSA keypairs — no network, full
  token matrix (06).

## Handler contracts

```ts
// entry-serve.ts
async function serveEntry(request: Request, deps: { config; pages; objects; cache });
// returns entry HTML (injected base), or 301 for image/raw, or 404/500 via errors.ts

// admin-api.ts — each handler: (request, ctx, deps) => Response
async function handleListPages(...);    // GET  /api/pages
async function handleCreatePage(...);   // POST /api/pages   (multipart + manifest, form-parser)
async function handleGetPage(...);      // GET  /api/pages/{id}
async function handlePatchPage(...);    // PATCH /api/pages/{id}
async function handleDeletePage(...);   // DELETE /api/pages/{id}
async function handleAddFiles(...);     // POST /api/pages/{id}/files
async function handleDeleteFile(...);   // DELETE /api/pages/{id}/files/{path}
```

Every mutating handler: (1) mutate D1/R2, (2) `ctx.waitUntil(cache.purgePage(ctx, id))` (or
await — non-fatal), (3) respond `no-store`. Admin responses are JSON with the error shape from
05; the admin UI (`admin-ui.ts`) posts to these endpoints (§10).

## Cross-cutting: error boundary

`index.ts` wraps dispatch in one `try/catch`; handlers throw `AppError`; anything else becomes
a generic 500 with `no-store` and no stack leakage (ADR 0005; S12 AC). See 05.

## Cross-references

- Spec: §2, §5, §6, §7, §8, §9, §10, §12, §14.
- Docs: [01 — System overview](01-system-overview.md), [03 — Data model](03-data-model.md),
  [05 — Error handling](05-error-handling.md), [06 — Test strategy](06-test-strategy.md).
- ADRs: 0002 (toolchain/deps), 0005 (errors/auth), 0006 (cache/rev), 0007 (slugs),
  0008 (base), 0009 (cache seam).
