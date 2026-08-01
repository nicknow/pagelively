import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createCacheService } from "../src/cache-service";

// S12/S13 — Cache seam: headers and purge adapter.

describe("createCacheService", () => {
  const cache = createCacheService(env);

  it("delegates headersFor to the pure cache-headers module", () => {
    const headers = cache.headersFor("entry", "page-123");
    expect(headers.get("Cache-Control")).toBe("public, max-age=300, stale-while-revalidate=3600");
    expect(headers.get("Cache-Tag")).toBe("page-page-123");
  });

  it("throws when purgePage is called without ctx.cache", async () => {
    const ctx = {} as ExecutionContext;
    await expect(cache.purgePage(ctx, "page-123")).rejects.toMatchObject({
      code: "cache_not_available",
      status: 500,
    });
  });

  it("calls ctx.cache.purge with the correct tag", async () => {
    const purge = vi.fn().mockResolvedValue({ success: true, errors: [] });
    const ctx = { cache: { purge } } as unknown as ExecutionContext;
    await cache.purgePage(ctx, "page-123");
    expect(purge).toHaveBeenCalledWith({ tags: ["page-page-123"] });
  });

  it("throws when purgePages is called without ctx.cache", async () => {
    const ctx = {} as ExecutionContext;
    await expect(cache.purgePages(ctx, ["page-123", "page-456"])).rejects.toMatchObject({
      code: "cache_not_available",
      status: 500,
    });
  });

  it("calls ctx.cache.purge with tags for all ids", async () => {
    const purge = vi.fn().mockResolvedValue({ success: true, errors: [] });
    const ctx = { cache: { purge } } as unknown as ExecutionContext;
    await cache.purgePages(ctx, ["a", "b"]);
    expect(purge).toHaveBeenCalledWith({ tags: ["page-a", "page-b"] });
  });

  it("is a no-op for purgePages with an empty list", async () => {
    const purge = vi.fn();
    const ctx = { cache: { purge } } as unknown as ExecutionContext;
    await cache.purgePages(ctx, []);
    expect(purge).not.toHaveBeenCalled();
  });
});
