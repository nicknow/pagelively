# 0017: S08 — Trailing-slash redirects and clean 404 response shape

- Status: accepted
- Date: 2026-07-31

## Context

S08 adds the first public-facing response factories to `src/redirects.ts`: a 301
path-normalization redirect (`/{slug}` → `/{slug}/`, `/p/{id}` → `/p/{id}/`) and a
safe 404 HTML page. The spec (§5, §11) mandates the redirect and the clean 404, but
leaves two implementation choices open:

1. Should the trailing-slash redirect use a relative or absolute `Location` header?
2. Should it carry a `Cache-Control` header? The architecture's `redirect` route class
   (S07, architecture 04) is intended for image/raw 301s to CDN objects and requires a
   `pageId` tag; the trailing-slash redirect has no page-id in scope.

## Decision

1. **`Location` is an absolute URL.** The redirect is built by copying the request URL,
   appending `/` to the pathname, and serializing the full URL (`url.toString()`). This
   preserves the scheme, host, port, query string, and hash explicitly (RFC 7231 allows
   both forms; the absolute form is unambiguous and matches the spec's "preserves host,
   scheme, port" acceptance criterion).
2. **Trailing-slash redirects carry no `Cache-Control` in `redirects.ts`.** They are a
   stable path normalization, not a per-page content redirect. Without a `pageId` in
   scope they cannot be tagged with `Cache-Tag: page-{id}`, and the architecture 04
   `redirect` route class is specifically for image/raw → CDN 301s. The caller (S12) may
   still add headers if policy changes; the factory intentionally does not bake one in.
   (RFC 7231 permits 301 responses to be cached by default; browsers will typically
   heuristically cache the redirect.)
3. **The clean 404 page displays the _decoded_ request pathname**, then HTML-escapes it.
   The decoded path is what the user typed/requested; the encoded form (`%3C`) is a wire
   encoding artifact. If decoding fails, the function falls back to the encoded pathname so
   a malformed request never throws while rendering the error page.
4. **The 404 page uses `headersFor("notFound")` from S07** for `Cache-Control: no-store`,
   then sets `Content-Type: text/html; charset=utf-8`. The body is a minimal HTML document
   with `<title>Not Found</title>`, no stack traces, and no internal details.

## Consequences

- The absolute `Location` is slightly longer on the wire but removes any ambiguity about
  host/port preservation and works behind reverse proxies.
- The lack of explicit cache headers keeps the 301 simple and separates the stable
  path-normalization concern from the per-page content redirects that carry `Cache-Tag`.
- Decoding the 404 path gives a readable message while `escapeHtml` prevents XSS even if
  the path contains `<`, `>`, `&`, quotes, or hashes.
- Future changes to cache headers for trailing-slash redirects require a decision in S12
  (or a later slice) rather than a hidden default in this helper.

## Cross-references

- Spec: §5 (URL paths), §11 (404/redirect behavior).
- Docs: `docs/architecture/02-module-boundaries-contracts.md` (redirects.ts contract),
  `docs/architecture/04-caching-rev-model.md` (route-class header policy).
- ADRs: 0006 (caching model), 0016 (S07 cache-header construction).
