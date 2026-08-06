import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { createCacheService, createTestCacheService } from "../src/cache-service";

// S13 — Cache seam: production purge adapter + recording test double.

function spyConsole(): { logs: unknown[][]; restore(): void } {
  const logs: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => logs.push(args);
  return {
    logs,
    restore() {
      console.error = original;
    },
  };
}

async function withSpiedConsoleAsync<T>(
  fn: (spy: { logs: unknown[][] }) => Promise<T>,
): Promise<T> {
  const spy = spyConsole();
  try {
    return await fn(spy);
  } finally {
    spy.restore();
  }
}

describe("createCacheService (production)", () => {
  const cache = createCacheService(env);

  it("delegates headersFor to the pure cache-headers module", () => {
    const headers = cache.headersFor("entry", "page-123");
    expect(headers.get("Cache-Control")).toBe("public, max-age=300, stale-while-revalidate=3600");
    expect(headers.get("Cache-Tag")).toBe("page-page-123");
  });

  it("delegates headersFor for route classes that do not need a page id", () => {
    const headers = cache.headersFor("admin");
    expect(headers.get("Cache-Control")).toBe("no-store");
    expect(headers.get("Cache-Tag")).toBeNull();
  });

  it("calls ctx.cache.purge with the correct tag", async () => {
    const purge = vi.fn().mockResolvedValue({ success: true, errors: [] });
    const ctx = { cache: { purge } } as unknown as ExecutionContext;
    await cache.purgePage(ctx, "page-123");
    expect(purge).toHaveBeenCalledWith({ tags: ["page-page-123"] });
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

  it("does not throw when purgePage is called without ctx.cache", async () => {
    const ctx = {} as ExecutionContext;
    await expect(cache.purgePage(ctx, "page-123")).resolves.toBeUndefined();
  });

  it("does not throw when purgePages is called without ctx.cache", async () => {
    const ctx = {} as ExecutionContext;
    await expect(cache.purgePages(ctx, ["a", "b"])).resolves.toBeUndefined();
  });

  it("swallows purge errors without throwing", async () => {
    await withSpiedConsoleAsync(async () => {
      const purge = vi.fn().mockRejectedValue(new Error("purge rate limited"));
      const ctx = { cache: { purge } } as unknown as ExecutionContext;
      await expect(cache.purgePage(ctx, "page-123")).resolves.toBeUndefined();
      expect(purge).toHaveBeenCalledWith({ tags: ["page-page-123"] });
    });
  });

  it("swallows purge result errors without throwing", async () => {
    await withSpiedConsoleAsync(async () => {
      const purge = vi
        .fn()
        .mockResolvedValue({ success: false, errors: [{ code: 1000, message: "rate limited" }] });
      const ctx = { cache: { purge } } as unknown as ExecutionContext;
      await expect(cache.purgePage(ctx, "page-123")).resolves.toBeUndefined();
    });
  });

  it("logs when ctx.cache is absent", async () => {
    await withSpiedConsoleAsync(async (spy) => {
      const ctx = {} as ExecutionContext;
      await cache.purgePage(ctx, "page-123");
      expect(spy.logs.length).toBeGreaterThan(0);
      expect(spy.logs[0]?.join(" ")).toContain("page-page-123");
    });
  });

  it("logs when purge throws", async () => {
    await withSpiedConsoleAsync(async (spy) => {
      const purge = vi.fn().mockRejectedValue(new Error("boom"));
      const ctx = { cache: { purge } } as unknown as ExecutionContext;
      await cache.purgePage(ctx, "page-123");
      expect(spy.logs.length).toBeGreaterThan(0);
    });
  });

  it("passes an empty pageId through to a literal page- tag (caller discipline: validateId first)", async () => {
    const purge = vi.fn().mockResolvedValue({ success: true, errors: [] });
    const ctx = { cache: { purge } } as unknown as ExecutionContext;
    await cache.purgePage(ctx, "");
    expect(purge).toHaveBeenCalledWith({ tags: ["page-"] });
  });

  it("logs and does not throw when purge returns a result with errors", async () => {
    await withSpiedConsoleAsync(async (spy) => {
      const purge = vi
        .fn()
        .mockResolvedValue({ success: false, errors: [{ code: 7000, message: "rate limited" }] });
      const ctx = { cache: { purge } } as unknown as ExecutionContext;
      await expect(cache.purgePage(ctx, "page-123")).resolves.toBeUndefined();
      expect(spy.logs.length).toBeGreaterThan(0);
      // console.error uses printf-style %o placeholders; raw args are captured.
      expect(spy.logs[0]?.[0]).toContain("purge failed");
      expect(spy.logs[0]?.[1]).toContainEqual({ code: 7000, message: "rate limited" });
      expect(spy.logs[0]?.[2]).toContain("page-page-123");
    });
  });
});

describe("createTestCacheService", () => {
  it("delegates headersFor to the pure cache-headers module", () => {
    const testCache = createTestCacheService();
    const headers = testCache.headersFor("entry", "abc");
    expect(headers.get("Cache-Control")).toBe("public, max-age=300, stale-while-revalidate=3600");
    expect(headers.get("Cache-Tag")).toBe("page-abc");
  });

  it("records a single page purge tag", async () => {
    const testCache = createTestCacheService();
    const ctx = {} as ExecutionContext;
    await testCache.purgePage(ctx, "abc");
    expect(testCache.getPurgeTags()).toEqual(["page-abc"]);
  });

  it("records multiple page purge tags in parallel", async () => {
    const testCache = createTestCacheService();
    const ctx = {} as ExecutionContext;
    await testCache.purgePages(ctx, ["abc", "def"]);
    expect(testCache.getPurgeTags()).toEqual(["page-abc", "page-def"]);
  });

  it("does not record anything for an empty purgePages list", async () => {
    const testCache = createTestCacheService();
    const ctx = {} as ExecutionContext;
    await testCache.purgePages(ctx, []);
    expect(testCache.getPurgeTags()).toEqual([]);
  });

  it("does not throw when ctx.cache is missing", async () => {
    const testCache = createTestCacheService();
    await expect(testCache.purgePage({} as ExecutionContext, "abc")).resolves.toBeUndefined();
  });

  it("records multiple calls to purgePage in order", async () => {
    const testCache = createTestCacheService();
    await testCache.purgePage({} as ExecutionContext, "abc");
    await testCache.purgePage({} as ExecutionContext, "def");
    await testCache.purgePage({} as ExecutionContext, "abc");
    expect(testCache.getPurgeTags()).toEqual(["page-abc", "page-def", "page-abc"]);
  });

  it("maps mixed ids to tags in order for purgePages", async () => {
    const testCache = createTestCacheService();
    await testCache.purgePages({} as ExecutionContext, ["abc", "", "def"]);
    expect(testCache.getPurgeTags()).toEqual(["page-abc", "page-", "page-def"]);
  });

  it("returns a defensive copy of recorded tags", async () => {
    const testCache = createTestCacheService();
    await testCache.purgePage({} as ExecutionContext, "abc");
    const first = testCache.getPurgeTags();
    const second = testCache.getPurgeTags();
    expect(first).toEqual(["page-abc"]);
    expect(second).toEqual(["page-abc"]);
    expect(first).not.toBe(second);
    first.push("tampered");
    expect(testCache.getPurgeTags()).toEqual(["page-abc"]);
  });

  it("produces the same tag sequence as the production implementation", async () => {
    const testCache = createTestCacheService();
    const prodPurge = vi.fn().mockResolvedValue({ success: true, errors: [] });
    const prodCache = createCacheService(env);
    const ctx = { cache: { purge: prodPurge } } as unknown as ExecutionContext;

    await testCache.purgePage({} as ExecutionContext, "abc");
    await testCache.purgePages({} as ExecutionContext, ["def", "ghi"]);
    await prodCache.purgePage(ctx, "abc");
    await prodCache.purgePages(ctx, ["def", "ghi"]);

    expect(testCache.getPurgeTags()).toEqual(["page-abc", "page-def", "page-ghi"]);
    expect(prodPurge).toHaveBeenNthCalledWith(1, { tags: ["page-abc"] });
    expect(prodPurge).toHaveBeenNthCalledWith(2, { tags: ["page-def", "page-ghi"] });
  });
});
