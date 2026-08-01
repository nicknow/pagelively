/**
 * S13 — Cache seam: headers + purge adapter (architecture 02, ADR 0009, 0022).
 *
 * The public pipeline depends on this interface rather than on `ctx.cache`
 * directly, so tests can inject a recording fake and production can swap the
 * underlying purge implementation without touching the handlers.
 *
 * `headersFor` is the pure policy from S07; `purgePage`/`purgePages` call
 * `ctx.cache.purge({ tags: [...] })` with the page id tag shape `page-{id}`
 * (spec §11, ADR 0006). Purge failures are best-effort: logged and swallowed,
 * because the mutation that triggered the purge has already committed. A
 * missing `ctx.cache` (local non-cached environments) is handled silently.
 */

import { headersFor, type CacheRouteClass } from "./cache-headers";

export interface CacheService {
  headersFor(routeClass: CacheRouteClass, pageId?: string): Headers;
  purgePage(ctx: ExecutionContext, pageId: string): Promise<void>;
  purgePages(ctx: ExecutionContext, ids: string[]): Promise<void>;
}

/** Tag used for cache purge, derived from the page id. */
function pageTag(pageId: string): string {
  return `page-${pageId}`;
}

/**
 * Best-effort purge helper. Logs and swallows failures because the write that
 * triggered the purge has already succeeded.
 */
async function purgeTags(ctx: ExecutionContext, tags: string[]): Promise<void> {
  if (tags.length === 0) {
    return;
  }

  const cacheApi = ctx.cache;
  if (!cacheApi) {
    // Local emulation (and any non-cached environment) does not provide
    // ctx.cache; the purge is a no-op. The operator checklist covers live
    // purge/HIT verification.
    console.error("[cache] purge skipped: ctx.cache not available (tags: %o)", tags);
    return;
  }

  try {
    const result = await cacheApi.purge({ tags });
    if (!result.success || result.errors.length > 0) {
      console.error("[cache] purge failed: %o (tags: %o)", result.errors, tags);
    }
  } catch (error) {
    console.error("[cache] purge threw: %o (tags: %o)", error, tags);
  }
}

export function createCacheService(env: Env): CacheService {
  // Reserved for future KV-backed JWKS cache wiring; headers + purge do not
  // need env in S13.
  void env;

  return {
    headersFor,

    async purgePage(ctx: ExecutionContext, pageId: string): Promise<void> {
      await purgeTags(ctx, [pageTag(pageId)]);
    },

    async purgePages(ctx: ExecutionContext, ids: string[]): Promise<void> {
      await purgeTags(ctx, ids.map(pageTag));
    },
  };
}

/**
 * Test double that records the exact tags passed to purge. This lets the purge
 * contract be asserted without relying on the Workers Caching emulation, which
 * does not support tag purges in the local pool (ADR 0009).
 */
export function createTestCacheService(): CacheService & { getPurgeTags(): string[] } {
  const tags: string[] = [];

  return {
    headersFor,

    async purgePage(_ctx: ExecutionContext, pageId: string): Promise<void> {
      tags.push(pageTag(pageId));
    },

    async purgePages(_ctx: ExecutionContext, ids: string[]): Promise<void> {
      for (const id of ids) {
        tags.push(pageTag(id));
      }
    },

    getPurgeTags(): string[] {
      return [...tags];
    },
  };
}
