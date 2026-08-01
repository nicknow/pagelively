# 0020: S11 implementation details — R2 object store adapter

- Status: accepted
- Date: 2026-07-31

## Context

Slice S11 ("R2 object store — key layout + metadata") wires `src/object-store.ts`, the
injected-R2 adapter for all page objects. The big decisions are small because the heavy rules
(key layout, path validation, rev invariants) were already locked in S03/ADR 0012 and the
module boundary was already defined in architecture 02. What remained for this slice:

- How strictly to validate the `body` argument before calling R2.
- How to store the immutable-asset `Cache-Control` header so R2's CDN-host serving echoes it
  without a Worker (spec §11, architecture 03).
- How `deletePageObjects` should paginate through R2 `list` results and issue batch deletes.
- What typed errors the adapter exposes.
- Whether the module ever touches `Env` or runtime bindings (it does not).

Platform facts were re-verified against the current R2 Workers API docs:

- `R2Bucket.put` accepts `ArrayBuffer | ArrayBufferView | string | null | Blob | ReadableStream`
  and stores `httpMetadata` (incl. `cacheControl`) which is echoed on later reads
  (`R2Object.httpMetadata`).
- `R2Bucket.list` returns up to 1000 entries per call, may return fewer, and exposes `truncated`
  plus `cursor` for pagination; apps must loop on `truncated`, not on `objects.length`
  ([Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)).
- `R2Bucket.delete` accepts a `string | string[]` and deletes up to 1000 keys per call
  ([Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)).

## Decision

### 1. Key layout is the S03 contract, enforced before R2

- `validateId(pageId)` runs in every public method before any key is built; invalid ids throw
  `AppError("invalid_id", 400)`.
- `buildR2Key(pageId, rev, path)` from `src/rev.ts` is the only key builder (architecture 02);
  it enforces `rev >= 1` (`invalid_rev`, 500) and path rules (`path_traversal`, 400).
- The adapter never interpolates a raw id or path into an R2 key.

### 2. Metadata storage: `httpMetadata` with immutable cache control

- `put` stores `httpMetadata: { contentType, cacheControl: "public, max-age=31536000, immutable" }`.
  This is the asset immutability contract from spec §11 and ADR 0006: because every URL embeds
  `{rev}`, the object can be cached forever; a republish changes the URL.
- `get` reads `r2Object.httpMetadata.contentType` and `r2Object.size` back out. If the object
  lacks `httpMetadata` (e.g. an object written outside this adapter), it falls back to
  `application/octet-stream`.

### 3. `deletePageObjects` paginates with `list` then batch deletes

- Prefix: `pages/{pageId}/` — deletes all revisions and all paths for a page.
- Page size: `100` (well under the 1000-key list/delete cap). This keeps per-iteration memory
  low and gives a small, testable page size.
- Loop: `do { list } while (cursor)`; each iteration deletes the returned keys in one
  `bucket.delete(keys)` call. The loop terminates when `truncated` is false.
- No error when the prefix has no objects; the loop simply exits.
- This is not GC of old revs — rev GC is deferred (OQ-10); this only deletes the current page's
  namespace.

### 4. Body validation

- `put` accepts exactly the types the R2 API accepts and the contract advertises:
  `ArrayBuffer | ReadableStream | Blob | string | null`. Other values throw
  `AppError("invalid_body", 400)` before calling R2.
- `contentType` must be a non-empty string; otherwise `AppError("invalid_content_type", 400)`.
  This prevents storing an object with a missing or malformed content type.

### 5. Error taxonomy

- Unexpected R2 failures are wrapped as:
  - `object_read_failed` (500) for `get` errors.
  - `object_write_failed` (500) for `put` and `deletePageObjects` errors.
- The public message is generic; the original error message/string is kept as `detail` for logs.
- Validation errors from the S03 contract are surfaced unchanged (`invalid_id`, `invalid_rev`,
  `path_traversal`).

### 6. No runtime binding access

- The module exports a factory `createObjectStore(bucket: R2Bucket)` and uses only the injected
  `R2Bucket`. It does not import `Env` or access global bindings.

## Consequences

- The adapter is trivial to test and mock: any object with `put`, `get`, `list`, `delete` works.
- CDN-host serving of assets is correct by construction: the object carries the right MIME type
  and the immutable cache header, so no Worker is needed on the asset path.
- `deletePageObjects` cannot exceed 100 keys per iteration, but it can delete arbitrarily many
  objects across revs because it loops.
- The adapter does not implement `deleteFile` (per S11 AC); that will be added in S18.
- Coverage: `src/object-store.ts` 100% statement/line; all branches and error paths are exercised.

## Cross-references

- Spec: §8 (R2 layout), §11 (immutable asset caching).
- Docs: `docs/architecture/02` (object-store contract), `docs/architecture/03` (R2 section).
- ADRs: 0012 (S03 — key builder, rev invariants), 0006 (caching/rev), 0005 (error taxonomy).
- Roadmap: S11 AC.
