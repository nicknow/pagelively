/**
 * S07 — Cache-header construction (spec §11, ADR 0006, architecture 04).
 *
 * Pure module: route class → Web API `Headers` object carrying the exact
 * cache policy for that class. No bindings, no I/O, no Cloudflare API calls.
 *
 * The route-class table is data (a `Record<CacheRouteClass, CachePolicy>`) so
 * the policy is easy to audit and change in one place. Callers in S12/S13/S15
 * use this through the `CacheService` seam (architecture 02).
 */

import { AppError } from "./errors";

/**
 * Route classes that need a cache-control policy. This is broader than the
 * `CacheService.headersFor` seam argument (which may be restricted to the
 * classes a handler can actually reach), but the pure function is the source
 * of truth for all of them.
 */
export type CacheRouteClass =
  | "entry" // /{slug}/, /p/{id}/, home page
  | "redirect" // 301 image/raw → CDN object
  | "asset" // R2 CDN-served object
  | "admin" // admin UI + API
  | "notFound" // clean 404
  | "error"; // generic 500

interface CachePolicy {
  /** Exact Cache-Control directive string. */
  cacheControl: string;
  /** True if this class needs a Cache-Tag derived from pageId. */
  needsPageId: boolean;
}

/**
 * Locked policies from OQ-01 / ADR 0006 / architecture 04.
 *
 * Entry and redirect share the same SWR policy because the 301 target embeds
 * the per-publish `rev`, so it is stable per rev and tag-purge refreshes it on
 * mutation (architecture 04, "Route-class header policy" notes).
 *
 * Asset responses are immutable by URL construction (`pages/{id}/{rev}/…`).
 *
 * Admin, notFound, and error are never cached.
 */
const POLICY: Record<CacheRouteClass, CachePolicy> = {
  entry: {
    cacheControl: "public, max-age=300, stale-while-revalidate=3600",
    needsPageId: true,
  },
  redirect: {
    cacheControl: "public, max-age=300, stale-while-revalidate=3600",
    needsPageId: true,
  },
  asset: {
    cacheControl: "public, max-age=31536000, immutable",
    needsPageId: false,
  },
  admin: {
    cacheControl: "no-store",
    needsPageId: false,
  },
  notFound: {
    cacheControl: "no-store",
    needsPageId: false,
  },
  error: {
    cacheControl: "no-store",
    needsPageId: false,
  },
};

/**
 * Returns the cache headers for a given route class.
 *
 * @param routeClass — which policy to apply
 * @param pageId — required for `entry` and `redirect`; ignored for other classes
 *   (caller discipline: must already be validated, S15/S17/S18).
 * @throws AppError — `missing_page_id` (500) for entry/redirect without pageId;
 *   `unknown_route_class` (500) for an unrecognized class.
 */
export function headersFor(routeClass: CacheRouteClass, pageId?: string): Headers {
  const policy = POLICY[routeClass];
  if (!policy) {
    throw new AppError("unknown_route_class", 500, `Unknown cache route class: ${routeClass}`);
  }

  if (policy.needsPageId && (pageId === undefined || pageId === "")) {
    throw new AppError("missing_page_id", 500, `pageId is required for route class ${routeClass}`);
  }

  const headers = new Headers();
  headers.set("Cache-Control", policy.cacheControl);

  if (policy.needsPageId && pageId !== undefined) {
    // pageId format validation is the caller's discipline (S15/S17/S18).
    headers.set("Cache-Tag", `page-${pageId}`);
  }

  return headers;
}
