/**
 * S08 — Trailing-slash redirects & clean 404 (spec §5, §11).
 *
 * Pure helpers used by the public-serving pipeline (S12). They have no bindings
 * and no Cloudflare API access. The trailing-slash redirect is a path
 * normalization: `/{slug}` → 301 `/{slug}/`, `/p/{id}` → 301 `/p/{id}/`.
 * Everything else (root, health, admin, api, unknown, and already-slash
 * slug/id paths) returns `null`, leaving the caller to 404 or handle directly.
 *
 * The clean 404 factory returns a minimal HTML document that displays the
 * requested path, HTML-escaped, so malformed paths never become XSS vectors.
 */

import type { Route } from "./router";
import { headersFor } from "./cache-headers";
import { escapeHtml } from "./utils";

/**
 * Decode a URL pathname for display in a 404 page. If the pathname contains
 * an invalid percent-encoding sequence, fall back to the raw encoded string so
 * the page never throws on a malformed request.
 */
function decodedPathname(url: URL): string {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return url.pathname;
  }
}

/**
 * Returns a 301 redirect to the same URL with a trailing slash appended to the
 * pathname, or `null` when no redirect is needed.
 *
 * The redirect only applies to slug (`/{slug}`) and id (`/p/{id}`) routes whose
 * pathname does NOT end with `/`. The Location preserves the original scheme,
 * host, port, pathname, query string, and hash.
 *
 * The response body is `null` for HEAD requests and a small informational
 * text body for other methods; a 301 body is typically ignored by clients.
 *
 * No Cache-Control is attached here: the trailing-slash redirect is a stable
 * path normalization that lacks a page-id in scope, so the caller (S12) can
 * layer cache headers if policy changes. (Documented in ADR 0017.)
 */
export function trailingSlashRedirect(route: Route, url: URL, method?: string): Response | null {
  if (route.type !== "slug" && route.type !== "id") {
    return null;
  }

  if (url.pathname.endsWith("/")) {
    return null;
  }

  const target = new URL(url.toString());
  target.pathname += "/";

  const location = target.toString();

  return new Response(method === "HEAD" ? null : `Redirecting to ${location}`, {
    status: 301,
    headers: {
      Location: location,
    },
  });
}

/**
 * Returns a minimal, safe 404 HTML response for an unknown path on the Worker
 * host.
 *
 * - `Content-Type: text/html; charset=utf-8`
 * - `Cache-Control: no-store` (via `headersFor("notFound")` from S07)
 * - Body is a valid HTML document with `<title>Not Found</title>` and the
 *   escaped requested pathname.
 */
export function clean404Response(url: URL): Response {
  const headers = headersFor("notFound");
  headers.set("Content-Type", "text/html; charset=utf-8");

  const path = escapeHtml(decodedPathname(url));

  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Not Found</title>
</head>
<body>
  <h1>Not Found</h1>
  <p>The page <code>${path}</code> was not found.</p>
</body>
</html>`;

  return new Response(body, { status: 404, headers });
}
