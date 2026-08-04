import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createObjectStore } from "../src/object-store";

// S11 — R2 object store adapter (key layout + metadata) (spec §8, architecture 02/03,
// ADR 0012). Tests run against the local Vitest Workers pool R2 emulation.

const TEST_ID = "A1b2C3d4E5";
const TEST_REV = 1;

async function textFromStream(stream: ReadableStream): Promise<string> {
  return new Response(stream).text();
}

async function listAllKeys(bucket: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const result = await bucket.list({ prefix, cursor, limit: 1000 });
    keys.push(...result.objects.map((o) => o.key));
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);
  return keys;
}

describe("createObjectStore", () => {
  const bucket = env.BUCKET;
  const store = createObjectStore(bucket);

  beforeEach(async () => {
    // Wipe the whole bucket between tests to ensure isolation.
    const keys = await listAllKeys(bucket, "");
    if (keys.length > 0) {
      await bucket.delete(keys);
    }
  });

  // --- put / get happy path ---

  describe("put", () => {
    it("writes an object with the correct R2 key layout", async () => {
      await store.put(
        TEST_ID,
        TEST_REV,
        "index.html",
        "<h1>Hello</h1>",
        "text/html; charset=utf-8",
      );
      const head = await bucket.head("pages/A1b2C3d4E5/1/index.html");
      expect(head).not.toBeNull();
      expect(head!.size).toBeGreaterThan(0);
    });

    it("accepts an ArrayBuffer body", async () => {
      const body = new TextEncoder().encode("binary bytes").buffer as ArrayBuffer;
      await store.put(TEST_ID, TEST_REV, "data.bin", body, "application/octet-stream");
      const obj = await store.get(TEST_ID, TEST_REV, "data.bin");
      expect(obj).not.toBeNull();
      expect(await textFromStream(obj!.body)).toBe("binary bytes");
    });

    it("accepts a ReadableStream body", async () => {
      // Use a Response body so the stream has a known length, which the local R2
      // emulation requires (real request/file streams also satisfy this).
      const stream = new Response("streamed").body;
      expect(stream).not.toBeNull();
      await store.put(TEST_ID, TEST_REV, "stream.txt", stream!, "text/plain");
      const obj = await store.get(TEST_ID, TEST_REV, "stream.txt");
      expect(obj).not.toBeNull();
      expect(await textFromStream(obj!.body)).toBe("streamed");
    });

    it("accepts a Blob body", async () => {
      const blob = new Blob(["blobbed"], { type: "text/plain" });
      await store.put(TEST_ID, TEST_REV, "blob.txt", blob, "text/plain");
      const obj = await store.get(TEST_ID, TEST_REV, "blob.txt");
      expect(obj).not.toBeNull();
      expect(await textFromStream(obj!.body)).toBe("blobbed");
    });

    it("accepts a null body", async () => {
      await store.put(TEST_ID, TEST_REV, "empty", null, "text/plain");
      const obj = await store.get(TEST_ID, TEST_REV, "empty");
      expect(obj).not.toBeNull();
      expect(obj!.size).toBe(0);
      expect(await textFromStream(obj!.body)).toBe("");
    });

    it("preserves folder paths", async () => {
      const html = "<html></html>";
      const css = "body { color: red; }";
      await store.put(TEST_ID, TEST_REV, "css/style.css", css, "text/css");
      await store.put(TEST_ID, TEST_REV, "images/pic.png", "PNG", "image/png");
      await store.put(TEST_ID, TEST_REV, "index.html", html, "text/html; charset=utf-8");

      const cssObj = await store.get(TEST_ID, TEST_REV, "css/style.css");
      const imgObj = await store.get(TEST_ID, TEST_REV, "images/pic.png");
      expect(await textFromStream(cssObj!.body)).toBe(css);
      expect(await textFromStream(imgObj!.body)).toBe("PNG");
    });

    it("round-trips a non-whitelisted content type such as application/json", async () => {
      const body = JSON.stringify({ hello: "world" });
      await store.put(TEST_ID, TEST_REV, "data.json", body, "application/json");
      const obj = await store.get(TEST_ID, TEST_REV, "data.json");
      expect(obj).not.toBeNull();
      expect(obj!.contentType).toBe("application/json");
      expect(await textFromStream(obj!.body)).toBe(body);
      const head = await bucket.head("pages/A1b2C3d4E5/1/data.json");
      expect(head).not.toBeNull();
      expect(head!.httpMetadata).toMatchObject({
        contentType: "application/json",
        cacheControl: "public, max-age=31536000, immutable",
      });
    });

    it("normalizes a non-escaping .. path segment to the canonical key", async () => {
      // buildR2Key collapses "images/../style.css" -> "style.css" (ADR 0012 d4).
      await store.put(TEST_ID, TEST_REV, "images/../style.css", "a{}", "text/css");
      const obj = await store.get(TEST_ID, TEST_REV, "style.css");
      expect(obj).not.toBeNull();
      expect(await textFromStream(obj!.body)).toBe("a{}");
      const head = await bucket.head("pages/A1b2C3d4E5/1/style.css");
      expect(head).not.toBeNull();
    });

    it("fully replaces an existing object at the same key (overwrite idempotency)", async () => {
      await store.put(TEST_ID, TEST_REV, "overwrite.txt", "first-body", "text/plain");
      await store.put(
        TEST_ID,
        TEST_REV,
        "overwrite.txt",
        "second-body",
        "text/html; charset=utf-8",
      );
      const obj = await store.get(TEST_ID, TEST_REV, "overwrite.txt");
      expect(obj).not.toBeNull();
      expect(await textFromStream(obj!.body)).toBe("second-body");
      expect(obj!.contentType).toBe("text/html; charset=utf-8");
      expect(obj!.size).toBe("second-body".length);
    });
  });

  describe("get", () => {
    it("returns body, contentType, and size for an existing object", async () => {
      const body = "hello world";
      await store.put(TEST_ID, TEST_REV, "file.txt", body, "text/plain");
      const obj = await store.get(TEST_ID, TEST_REV, "file.txt");
      expect(obj).not.toBeNull();
      expect(obj!.size).toBe(body.length);
      expect(await textFromStream(obj!.body)).toBe(body);
    });

    it("returns null when the object is missing", async () => {
      const obj = await store.get(TEST_ID, TEST_REV, "missing.txt");
      expect(obj).toBeNull();
    });

    it("reports the correct size for ArrayBuffer and Blob bodies", async () => {
      const ab = new TextEncoder().encode("hello").buffer as ArrayBuffer;
      await store.put(TEST_ID, TEST_REV, "ab.bin", ab, "application/octet-stream");
      const abObj = await store.get(TEST_ID, TEST_REV, "ab.bin");
      expect(abObj).not.toBeNull();
      expect(abObj!.size).toBe(5);

      const blob = new Blob(["hello world"], { type: "text/plain" });
      await store.put(TEST_ID, TEST_REV, "blob.bin", blob, "application/octet-stream");
      const blobObj = await store.get(TEST_ID, TEST_REV, "blob.bin");
      expect(blobObj).not.toBeNull();
      expect(blobObj!.size).toBe(11);
    });
  });

  describe("httpMetadata round-trip", () => {
    it("stores the contentType and immutable Cache-Control", async () => {
      await store.put(TEST_ID, TEST_REV, "asset.css", "a{}", "text/css");
      const head = await bucket.head("pages/A1b2C3d4E5/1/asset.css");
      expect(head).not.toBeNull();
      expect(head!.httpMetadata).toMatchObject({
        contentType: "text/css",
        cacheControl: "public, max-age=31536000, immutable",
      });
    });

    it("echoes the same contentType through the store get", async () => {
      await store.put(TEST_ID, TEST_REV, "main.html", "<p>hi</p>", "text/html; charset=utf-8");
      const obj = await store.get(TEST_ID, TEST_REV, "main.html");
      expect(obj).not.toBeNull();
      expect(obj!.contentType).toBe("text/html; charset=utf-8");
    });

    it("falls back to application/octet-stream when an object has no contentType", async () => {
      await bucket.put("pages/A1b2C3d4E5/1/raw.bin", new Uint8Array([1, 2, 3]));
      const obj = await store.get(TEST_ID, TEST_REV, "raw.bin");
      expect(obj).not.toBeNull();
      expect(obj!.contentType).toBe("application/octet-stream");
    });
  });

  describe("deletePageObjects", () => {
    it("removes all objects under pages/{id}/ across all revs", async () => {
      await store.put(TEST_ID, 1, "index.html", "v1", "text/html; charset=utf-8");
      await store.put(TEST_ID, 2, "index.html", "v2", "text/html; charset=utf-8");
      await store.put(TEST_ID, 2, "style.css", "css", "text/css");
      await store.put(TEST_ID, 3, "image.png", "PNG", "image/png");

      await store.deletePageObjects(TEST_ID);

      const keys = await listAllKeys(bucket, "pages/A1b2C3d4E5/");
      expect(keys).toEqual([]);
    });

    it("does not touch other pages", async () => {
      const otherId = "B2c3D4e5F6";
      await store.put(TEST_ID, 1, "index.html", "mine", "text/html; charset=utf-8");
      await store.put(otherId, 1, "index.html", "theirs", "text/html; charset=utf-8");

      await store.deletePageObjects(TEST_ID);

      expect(await store.get(otherId, 1, "index.html")).not.toBeNull();
      expect(await store.get(TEST_ID, 1, "index.html")).toBeNull();
    });

    it("does nothing when the page has no objects", async () => {
      await expect(store.deletePageObjects(TEST_ID)).resolves.toBeUndefined();
      const keys = await listAllKeys(bucket, "pages/A1b2C3d4E5/");
      expect(keys).toEqual([]);
    });

    it("paginates through large object lists", async () => {
      // Create enough objects that the adapter's internal page size must loop.
      // The adapter uses a page size of 100 so 250 objects require multiple pages.
      const count = 250;
      for (let i = 0; i < count; i++) {
        await store.put(TEST_ID, 1, `assets/file-${i}.txt`, `body ${i}`, "text/plain");
      }
      await store.deletePageObjects(TEST_ID);
      const keys = await listAllKeys(bucket, "pages/A1b2C3d4E5/");
      expect(keys).toEqual([]);
    });

    it("paginates across the internal page size boundary with 101 objects", async () => {
      // The adapter uses limit=100, so 101 objects force a cursor to a second page.
      for (let i = 0; i < 101; i++) {
        await store.put(TEST_ID, 1, `file-${i}.txt`, `body ${i}`, "text/plain");
      }
      await store.deletePageObjects(TEST_ID);
      const keys = await listAllKeys(bucket, "pages/A1b2C3d4E5/");
      expect(keys).toEqual([]);
    });
  });

  // --- input validation ---

  describe("input validation", () => {
    it("rejects an invalid pageId before R2", async () => {
      await expect(
        store.put("bad/id", TEST_REV, "file.txt", "x", "text/plain"),
      ).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });

    it("rejects an invalid pageId on get", async () => {
      await expect(store.get("bad/id", TEST_REV, "file.txt")).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });

    it("rejects an invalid pageId on deletePageObjects", async () => {
      await expect(store.deletePageObjects("bad/id")).rejects.toMatchObject({
        code: "invalid_id",
        status: 400,
      });
    });

    it("rejects an invalid rev before R2", async () => {
      await expect(store.put(TEST_ID, 0, "file.txt", "x", "text/plain")).rejects.toMatchObject({
        code: "invalid_rev",
        status: 500,
      });
      await expect(store.put(TEST_ID, -1, "file.txt", "x", "text/plain")).rejects.toMatchObject({
        code: "invalid_rev",
        status: 500,
      });
      await expect(store.put(TEST_ID, 1.5, "file.txt", "x", "text/plain")).rejects.toMatchObject({
        code: "invalid_rev",
        status: 500,
      });
    });

    it("rejects an invalid rev on get", async () => {
      await expect(store.get(TEST_ID, 0, "file.txt")).rejects.toMatchObject({
        code: "invalid_rev",
        status: 500,
      });
    });

    it("rejects path traversal", async () => {
      await expect(
        store.put(TEST_ID, TEST_REV, "../etc/passwd", "x", "text/plain"),
      ).rejects.toMatchObject({
        code: "path_traversal",
        status: 400,
      });
      await expect(
        store.put(TEST_ID, TEST_REV, "a/../../b", "x", "text/plain"),
      ).rejects.toMatchObject({
        code: "path_traversal",
        status: 400,
      });
    });

    it("rejects absolute and empty paths", async () => {
      await expect(
        store.put(TEST_ID, TEST_REV, "/file.txt", "x", "text/plain"),
      ).rejects.toMatchObject({
        code: "path_traversal",
        status: 400,
      });
      await expect(store.put(TEST_ID, TEST_REV, "", "x", "text/plain")).rejects.toMatchObject({
        code: "path_traversal",
        status: 400,
      });
    });

    it("rejects an invalid body type", async () => {
      await expect(
        store.put(TEST_ID, TEST_REV, "file.txt", 123 as unknown as string, "text/plain"),
      ).rejects.toMatchObject({
        code: "invalid_body",
        status: 400,
      });
    });

    it("rejects undefined and object body types", async () => {
      await expect(
        store.put(TEST_ID, TEST_REV, "file.txt", undefined as unknown as string, "text/plain"),
      ).rejects.toMatchObject({
        code: "invalid_body",
        status: 400,
      });
      await expect(
        store.put(TEST_ID, TEST_REV, "file.txt", { foo: "bar" } as unknown as string, "text/plain"),
      ).rejects.toMatchObject({
        code: "invalid_body",
        status: 400,
      });
    });

    it("rejects an ArrayBufferView body (Uint8Array) as off-contract", async () => {
      // The contract is ArrayBuffer | ReadableStream | Blob | string | null.
      // R2 accepts ArrayBufferView, but the adapter intentionally narrows the contract.
      const view = new TextEncoder().encode("bytes");
      await expect(
        store.put(
          TEST_ID,
          TEST_REV,
          "file.bin",
          view as unknown as ArrayBuffer,
          "application/octet-stream",
        ),
      ).rejects.toMatchObject({
        code: "invalid_body",
        status: 400,
      });
    });

    it("rejects an empty or non-string contentType", async () => {
      await expect(store.put(TEST_ID, TEST_REV, "file.txt", "x", "")).rejects.toMatchObject({
        code: "invalid_content_type",
        status: 400,
      });
      await expect(
        store.put(TEST_ID, TEST_REV, "file.txt", "x", 123 as unknown as string),
      ).rejects.toMatchObject({
        code: "invalid_content_type",
        status: 400,
      });
    });
  });

  describe("deletePageRevObjects", () => {
    it("removes all objects for a single rev", async () => {
      await store.put(TEST_ID, 1, "index.html", "v1", "text/html; charset=utf-8");
      await store.put(TEST_ID, 1, "style.css", "css", "text/css");
      await store.put(TEST_ID, 2, "index.html", "v2", "text/html; charset=utf-8");

      await store.deletePageRevObjects(TEST_ID, 1);

      expect(await listAllKeys(bucket, "pages/A1b2C3d4E5/1/")).toEqual([]);
      expect(await store.get(TEST_ID, 2, "index.html")).not.toBeNull();
    });

    it("does nothing when the rev has no objects", async () => {
      await expect(store.deletePageRevObjects(TEST_ID, 1)).resolves.toBeUndefined();
      expect(await listAllKeys(bucket, "pages/A1b2C3d4E5/1/")).toEqual([]);
    });

    it("paginates through large object lists", async () => {
      // The adapter uses a page size of 100 so 101 objects force a cursor.
      const count = 101;
      for (let i = 0; i < count; i++) {
        await store.put(TEST_ID, 1, `file-${i}.txt`, `body ${i}`, "text/plain");
      }
      await store.deletePageRevObjects(TEST_ID, 1);
      expect(await listAllKeys(bucket, "pages/A1b2C3d4E5/1/")).toEqual([]);
    });

    it("throws object_write_failed when the R2 list fails", async () => {
      const failingBucket = {
        ...bucket,
        async list() {
          throw new Error("R2 list unavailable");
        },
      } as unknown as R2Bucket;
      const failingStore = createObjectStore(failingBucket);
      await expect(failingStore.deletePageRevObjects(TEST_ID, 1)).rejects.toMatchObject({
        code: "object_write_failed",
        status: 500,
      });
    });

    it("throws object_write_failed when the R2 delete fails", async () => {
      const failingBucket = {
        ...bucket,
        async list() {
          return {
            objects: [{ key: "pages/A1b2C3d4E5/1/file.txt" } as R2Object],
            truncated: false,
            cursor: undefined,
          };
        },
        async delete() {
          throw new Error("R2 delete unavailable");
        },
      } as unknown as R2Bucket;
      const failingStore = createObjectStore(failingBucket);
      await expect(failingStore.deletePageRevObjects(TEST_ID, 1)).rejects.toMatchObject({
        code: "object_write_failed",
        status: 500,
      });
    });
  });

  // --- failure modes ---

  describe("failure modes", () => {
    it("throws object_read_failed (500) when R2 get fails unexpectedly", async () => {
      const failingBucket = {
        ...bucket,
        async get() {
          throw new Error("R2 unavailable");
        },
      } as unknown as R2Bucket;
      const failingStore = createObjectStore(failingBucket);
      await expect(failingStore.get(TEST_ID, TEST_REV, "file.txt")).rejects.toMatchObject({
        code: "object_read_failed",
        status: 500,
      });
    });

    it("throws object_write_failed (500) when R2 put fails unexpectedly", async () => {
      const failingBucket = {
        ...bucket,
        async put() {
          throw new Error("R2 unavailable");
        },
      } as unknown as R2Bucket;
      const failingStore = createObjectStore(failingBucket);
      await expect(
        failingStore.put(TEST_ID, TEST_REV, "file.txt", "x", "text/plain"),
      ).rejects.toMatchObject({
        code: "object_write_failed",
        status: 500,
      });
    });

    it("throws object_read_failed (500) when R2 get returns a non-Error rejection", async () => {
      const failingBucket = {
        ...bucket,
        async get() {
          throw "string error";
        },
      } as unknown as R2Bucket;
      const failingStore = createObjectStore(failingBucket);
      await expect(failingStore.get(TEST_ID, TEST_REV, "file.txt")).rejects.toMatchObject({
        code: "object_read_failed",
        status: 500,
      });
    });

    it("throws object_write_failed (500) when R2 put returns a non-Error rejection", async () => {
      const failingBucket = {
        ...bucket,
        async put() {
          throw "string error";
        },
      } as unknown as R2Bucket;
      const failingStore = createObjectStore(failingBucket);
      await expect(
        failingStore.put(TEST_ID, TEST_REV, "file.txt", "x", "text/plain"),
      ).rejects.toMatchObject({
        code: "object_write_failed",
        status: 500,
      });
    });

    it("throws object_write_failed (500) when R2 list fails during deletePageObjects", async () => {
      const failingBucket = {
        ...bucket,
        async list() {
          throw new Error("R2 list unavailable");
        },
      } as unknown as R2Bucket;
      const failingStore = createObjectStore(failingBucket);
      await expect(failingStore.deletePageObjects(TEST_ID)).rejects.toMatchObject({
        code: "object_write_failed",
        status: 500,
      });
    });

    it("throws object_write_failed (500) when R2 delete fails during deletePageObjects", async () => {
      const failingBucket = {
        ...bucket,
        async list() {
          return {
            objects: [{ key: "pages/A1b2C3d4E5/1/file.txt" } as R2Object],
            truncated: false,
            cursor: undefined,
          };
        },
        async delete() {
          throw new Error("R2 delete unavailable");
        },
      } as unknown as R2Bucket;
      const failingStore = createObjectStore(failingBucket);
      await expect(failingStore.deletePageObjects(TEST_ID)).rejects.toMatchObject({
        code: "object_write_failed",
        status: 500,
      });
    });
  });
});
