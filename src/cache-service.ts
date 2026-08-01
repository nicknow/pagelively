/**
 * S12/S13 — Cache seam: headers + purge adapter (architecture 02, ADR 0009).
 *
 * The public pipeline depends on this interface rather than on `ctx.cache`
 * directly, so tests can inject a recording fake and production can swap the
 * underlying purge implementation without touching the handlers.
 *
 * `headersFor` is the pure policy from S07; for S12 the purge methods are real
 * but not yet exercised by the public routes. They call `ctx.cache.purge()` with
 * the page id tag shape `page-{id}` (spec §11, ADR 0006).
 */

import { AppError } from "./errors";
import { headersFor, type CacheRouteClass } from "./cache-headers";

export interface CacheService {
  headersFor(routeClass: CacheRouteClass, pageId?: string): Headers;
  purgePage(ctx: ExecutionContext, pageId: string): Promise<void>;
  purgePages(ctx: ExecutionContext, ids: string[]): Promise<void>;
}

export function createCacheService(env: Env): CacheService {
  // Reserved for future KV-backed JWKS cache wiring; headers + purge do not
  // need env in S12.
  void env;

  return {
    headersFor,

    async purgePage(ctx: ExecutionContext, pageId: string): Promise<void> {
      const cache = ctx.cache;
      if (!cache) {
        throw new AppError(
          "cache_not_available",
          500,
          "Cache purge is not available in this environment.",
        );
      }
      await cache.purge({ tags: [`page-${pageId}`] });
    },

    async purgePages(ctx: ExecutionContext, ids: string[]): Promise<void> {
      if (ids.length === 0) return;
      const cache = ctx.cache;
      if (!cache) {
        throw new AppError(
          "cache_not_available",
          500,
          "Cache purge is not available in this environment.",
        );
      }
      await cache.purge({ tags: ids.map((id) => `page-${id}`) });
    },
  };
}
