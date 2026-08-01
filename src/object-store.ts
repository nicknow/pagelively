/**
 * S11 — R2 object store adapter (key layout + metadata) (spec §8, architecture 02/03,
 * ADR 0012).
 *
 * Thin, injectable wrapper over an `R2Bucket`. It is the only module that talks to R2
 * for page objects; all keys are built through `buildR2Key` from `rev.ts` so the layout
 * `pages/{id}/{rev}/{path}` is a hard contract. Input validation happens before any R2
 * call; unexpected R2 errors are surfaced as typed `AppError`s for the boundary handler.
 */

import { AppError } from "./errors";
import { validateId } from "./ids";
import { buildR2Key } from "./rev";

/** An object returned by the store. */
export interface StoredObject {
  body: ReadableStream;
  contentType: string;
  size: number;
}

/** Injected R2 adapter contract. */
export interface ObjectStore {
  put(
    pageId: string,
    rev: number,
    path: string,
    body: ArrayBuffer | ReadableStream | Blob | string | null,
    contentType: string,
  ): Promise<void>;
  get(pageId: string, rev: number, path: string): Promise<StoredObject | null>;
  deletePageObjects(pageId: string): Promise<void>;
}

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const LIST_PAGE_SIZE = 100;

export function createObjectStore(bucket: R2Bucket): ObjectStore {
  return {
    async put(pageId, rev, path, body, contentType): Promise<void> {
      assertValidPageId(pageId);
      assertValidBody(body);
      if (typeof contentType !== "string" || contentType === "") {
        throw new AppError("invalid_content_type", 400, "contentType must be a non-empty string.");
      }
      const key = buildR2Key(pageId, rev, path);
      try {
        await bucket.put(key, body, {
          httpMetadata: { contentType, cacheControl: IMMUTABLE_CACHE_CONTROL },
        });
      } catch (error) {
        throw wrapObjectWriteError(error);
      }
    },

    async get(pageId, rev, path): Promise<StoredObject | null> {
      assertValidPageId(pageId);
      const key = buildR2Key(pageId, rev, path);
      try {
        const object = await bucket.get(key);
        if (object === null) {
          return null;
        }
        const contentType = object.httpMetadata?.contentType ?? "application/octet-stream";
        return { body: object.body, contentType, size: object.size };
      } catch (error) {
        throw wrapObjectReadError(error);
      }
    },

    async deletePageObjects(pageId): Promise<void> {
      assertValidPageId(pageId);
      const prefix = `pages/${pageId}/`;
      try {
        let cursor: string | undefined;
        do {
          const list = await bucket.list({ prefix, limit: LIST_PAGE_SIZE, cursor });
          const keys = list.objects.map((object) => object.key);
          if (keys.length > 0) {
            await bucket.delete(keys);
          }
          cursor = list.truncated ? list.cursor : undefined;
        } while (cursor);
      } catch (error) {
        throw wrapObjectWriteError(error);
      }
    },
  };
}

function assertValidPageId(pageId: string): void {
  if (!validateId(pageId)) {
    throw new AppError("invalid_id", 400, "Invalid page id.");
  }
}

function assertValidBody(body: unknown): void {
  if (
    body === null ||
    typeof body === "string" ||
    body instanceof ArrayBuffer ||
    body instanceof ReadableStream ||
    body instanceof Blob
  ) {
    return;
  }
  throw new AppError(
    "invalid_body",
    400,
    "body must be an ArrayBuffer, ReadableStream, Blob, string, or null.",
  );
}

function wrapObjectReadError(error: unknown): AppError {
  return new AppError(
    "object_read_failed",
    500,
    "Object read failed.",
    error instanceof Error ? error.message : String(error),
  );
}

function wrapObjectWriteError(error: unknown): AppError {
  return new AppError(
    "object_write_failed",
    500,
    "Object write failed.",
    error instanceof Error ? error.message : String(error),
  );
}
