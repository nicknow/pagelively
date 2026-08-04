import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createObjectStore } from "../src/object-store";
import { createTestCacheService } from "../src/cache-service";
import { serveAsset, type AssetServeDependencies } from "../src/asset-serve";
import { validateStoredPath } from "../src/form-parser";

// S23-C — Worker-side protected asset serving (ADR 0041 decision 6; architecture
// 02 serveAsset contract). All responses are `headersFor("protected")` (no-store,
// never a Cache-Tag). No D1 read and no cookie check — deps carry only the R2
// seam + cache headers. Path validation runs BEFORE the R2 key is built.

const objects = createObjectStore(env.BUCKET);

function makeDeps(): AssetServeDependencies {
  return {
    objects,
    cache: createTestCacheService(),
  };
}

function assetUrl(id: string, rev: string, path: string): string {
  return `https://pages.example.com/assets/pages/${id}/${rev}/${path}`;
}

describe("serveAsset", () => {
  const bucket = env.BUCKET;

  beforeEach(async () => {
    let cursor: string | undefined;
    do {
      const list = await bucket.list({ cursor, limit: 1000 });
      const keys = list.objects.map((o) => o.key);
      if (keys.length > 0) await bucket.delete(keys);
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
  });

  it("serves stored object bytes with the stored content type and protected headers", async () => {
    await objects.put(
      "page100001",
      1,
      "index.html",
      "<!doctype html><html><head></head><body><p>Secret page</p></body></html>",
      "text/html; charset=utf-8",
    );

    const res = await serveAsset(
      new Request(assetUrl("page100001", "1", "index.html")),
      makeDeps(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Cache-Tag")).toBeNull();
    expect(await res.text()).toContain("<p>Secret page</p>");
  });

  it("falls back to application/octet-stream when the stored object has no content type", async () => {
    // Bypass the store adapter so no httpMetadata is attached to the R2 object.
    await bucket.put("pages/page100001/1/raw.bin", new TextEncoder().encode("blob-data"));

    const res = await serveAsset(new Request(assetUrl("page100001", "1", "raw.bin")), makeDeps());

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe("blob-data");
  });

  it("serves binary bytes for an image object (Worker bytes, never a 301)", async () => {
    await objects.put("page100001", 3, "photo.jpg", "fake-jpeg-bytes", "image/jpeg");

    const res = await serveAsset(new Request(assetUrl("page100001", "3", "photo.jpg")), makeDeps());

    expect(res.status).toBe(200);
    expect(res.headers.get("Location")).toBeNull();
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe("fake-jpeg-bytes");
  });

  it("returns a clean 404 for an unknown object", async () => {
    const res = await serveAsset(
      new Request(assetUrl("page100001", "1", "missing.html")),
      makeDeps(),
    );

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("Not Found");
  });

  it("rejects an invalid id format with invalid_id (400)", async () => {
    await expect(
      serveAsset(new Request(assetUrl("bad.id", "1", "index.html")), makeDeps()),
    ).rejects.toMatchObject({ code: "invalid_id", status: 400 });
  });

  it("rejects a non-integer rev with invalid_rev (400)", async () => {
    for (const rev of ["abc", "1.5", "0", "-1", "2e2", "NaN"]) {
      await expect(
        serveAsset(new Request(assetUrl("page100001", rev, "index.html")), makeDeps()),
      ).rejects.toMatchObject({ code: "invalid_rev", status: 400 });
    }
  });

  it("extended invalid-rev matrix: +1, 1e0, and 24-digit overflow also rejected", async () => {
    for (const rev of ["+1", "1e0", "999999999999999999999999"]) {
      await expect(
        serveAsset(new Request(assetUrl("page100001", rev, "index.html")), makeDeps()),
      ).rejects.toMatchObject({ code: "invalid_rev", status: 400 });
    }
  });

  it("leading-zero rev '01' is accepted and treated as rev 1", async () => {
    await objects.put("page100001", 1, "index.html", "rev-1-content", "text/html");
    const res = await serveAsset(
      new Request(assetUrl("page100001", "01", "index.html")),
      makeDeps(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("rev-1-content");
  });

  it("decoded ../ with a forward slash never reaches serveAsset → clean 404, sibling key never served", async () => {
    // Two shapes: "%2e%2e%2f" (encoded dots + encoded slash) is rejected by the
    // router's encoded-slash rule (unknown → 404); "%2e%2e/" (encoded dots +
    // literal slash) is normalized as a dot-segment by the URL parser (→ 404).
    await objects.put("page100001", 1, "sibling.html", "sibling", "text/html");

    for (const path of ["%2e%2e%2fetc/passwd", "%2e%2e/sibling.html"]) {
      const res = await serveAsset(new Request(assetUrl("page100001", "1", path)), makeDeps());
      expect(res.status).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.text()).toContain("Not Found");
    }
  });

  it("rejects the reachable decoded-traversal shape (..\ via %5C) with path_traversal (400)", async () => {
    // "%2e%2e%5c" decodes to "..\" — no encoded forward slash, so it reaches
    // serveAsset, where validateStoredPath rejects it BEFORE any R2 key is built.
    await expect(
      serveAsset(new Request(assetUrl("page100001", "1", "%2e%2e%5csibling.html")), makeDeps()),
    ).rejects.toMatchObject({ code: "path_traversal", status: 400 });
  });

  it("raw path traversal foo/../sibling.html resolves to the correct root-level sibling (URL parser normalization)", async () => {
    // foo/../sibling.html in a URL is normalized to sibling.html by the URL
    // parser BEFORE the Worker sees it. The normalized path must serve the
    // root-level sibling, never the nested foo/sibling.html.
    await objects.put("page100001", 1, "sibling.html", "ROOT-SIBLING", "text/html");
    await objects.put("page100001", 1, "foo/sibling.html", "FOO-SIBLING", "text/html");

    const res = await serveAsset(
      new Request(assetUrl("page100001", "1", "foo/../sibling.html")),
      makeDeps(),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("ROOT-SIBLING");
    expect(text).not.toContain("FOO-SIBLING");
  });

  it("rejects a decoded backslash with path_traversal (400)", async () => {
    await expect(
      serveAsset(new Request(assetUrl("page100001", "1", "a%5Cb.html")), makeDeps()),
    ).rejects.toMatchObject({ code: "path_traversal", status: 400 });
  });

  it("rejects a decoded percent sign with invalid_filename (400)", async () => {
    await expect(
      serveAsset(new Request(assetUrl("page100001", "1", "bad%25file.html")), makeDeps()),
    ).rejects.toMatchObject({ code: "invalid_filename", status: 400 });
  });

  it("returns a clean 404 for malformed percent-encoding (never 500)", async () => {
    for (const path of ["bad%2.html", "bad%zz.html", "a%2", "%"]) {
      const res = await serveAsset(
        new Request(assetUrl("page100001", "1", path)),
        makeDeps(),
      );
      expect(res.status, `path=${path}`).toBe(404);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.text()).toContain("Not Found");
    }
  });

  it("encoded slash a%2Fb.html is classified as unknown → clean 404", async () => {
    // %2F in a URL path is decoded to a literal "/" by the URL parser, changing
    // the path structure so it no longer matches the asset route pattern.
    const res = await serveAsset(
      new Request(assetUrl("page100001", "1", "a%2Fb.html")),
      makeDeps(),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("Not Found");
  });

  it("encoded dot-dot with a literal slash is normalized away at URL parse → clean 404, sibling key never served", async () => {
    // "%2e%2e" is recognized as a dot-segment by the WHATWG URL parser, so this
    // request path collapses to /assets/pages/page100001/x → unknown → clean 404.
    await objects.put("page100001", 1, "sibling.html", "sibling", "text/html");

    const res = await serveAsset(
      new Request(assetUrl("page100001", "1", "%2e%2e/sibling.html")),
      makeDeps(),
    );

    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("Not Found");
  });

  it("serves deep sub-paths under the page rev prefix", async () => {
    await objects.put("page100001", 1, "assets/css/style.css", "body {}", "text/css");

    const res = await serveAsset(
      new Request(assetUrl("page100001", "1", "assets/css/style.css")),
      makeDeps(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/css");
    expect(await res.text()).toBe("body {}");
  });
});

describe("validateStoredPath (shared read/write path validation)", () => {
  it("accepts relative, clean paths", () => {
    expect(() => validateStoredPath("index.html")).not.toThrow();
    expect(() => validateStoredPath("assets/css/style.css")).not.toThrow();
  });

  it("rejects an empty path with invalid_path (400)", () => {
    expect(() => validateStoredPath("")).toThrowError(
      expect.objectContaining({ code: "invalid_path", status: 400 }),
    );
  });

  it("rejects an absolute path with path_traversal (400)", () => {
    expect(() => validateStoredPath("/etc/passwd")).toThrowError(
      expect.objectContaining({ code: "path_traversal", status: 400 }),
    );
  });

  it("rejects ../ anywhere with path_traversal (400)", () => {
    for (const path of ["../etc/passwd", "a/../b"]) {
      expect(() => validateStoredPath(path)).toThrowError(
        expect.objectContaining({ code: "path_traversal", status: 400 }),
      );
    }
  });

  it("rejects backslashes with path_traversal (400)", () => {
    expect(() => validateStoredPath("a\\b.html")).toThrowError(
      expect.objectContaining({ code: "path_traversal", status: 400 }),
    );
  });

  it("rejects percent signs with invalid_filename (400)", () => {
    expect(() => validateStoredPath("bad%file.html")).toThrowError(
      expect.objectContaining({ code: "invalid_filename", status: 400 }),
    );
  });
});
