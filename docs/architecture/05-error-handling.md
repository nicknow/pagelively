# 05 — Error handling

One taxonomy, one boundary, predictable HTTP statuses. ADR 0005 records the decision; the
contract lives here.

## Model: `AppError`

Handlers throw; `index.ts` catches. A single `AppError` class carries a machine-readable code,
an HTTP status, a safe public message, and optional internal detail (logged, never sent):

```ts
class AppError extends Error {
  code: string; // snake_case, stable, e.g. "slug_taken"
  status: number; // 400 | 403 | 404 | 409 | 413 | 422 | 500
  publicMessage: string;
  detail?: unknown; // internal only — logged via console.error / ctx.waitUntil
}
```

The boundary in `index.ts`:

```
fetch(request) →
  try    → dispatch via classifyPath
  catch  → AppError?  → toErrorResponse(err, request)
           otherwise  → log(err); 500 generic (no stack leakage, no-store)
```

## Status code taxonomy

| Status | Code(s)                                                                                                                                                                                                                | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Spec        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 400    | `invalid_id`, `invalid_slug`, `invalid_manifest`, `invalid_json`, `invalid_content`, `invalid_format`, `ambiguous_entry`, `path_traversal`, `unsupported_type`, `missing_field`, `malformed_json`, `invalid_home_mode` | Malformed input that no retry-with-fixes can pass without changes. Includes **ambiguous entry detection** (OQ-11: server 400s with a clear message; the UI forces an entry picker instead) and the JSON paste validation surface (`invalid_json`, `invalid_content`, `invalid_format`, OQ-17/T4).                                                                                                                                                                                                                                       | §10, S17 AC |
| 403    | `access_denied` (missing/invalid/expired/wrong-aud/tampered/unknown-kid/malformed JWT), `auth_not_configured` (`ACCESS_AUD` unset — fail closed)                                                                       | JWT gate failures. **401 is intentionally unused**: there is no in-app auth (§9); Access handles the edge, and the defense-in-depth gate answers 403 for every failure mode (S16 AC).                                                                                                                                                                                                                                                                                                                                                   | §9, S16 AC  |
| 404    | `not_found`                                                                                                                                                                                                            | Unknown page id/slug, unknown file, unknown route. Clean HTML page on Worker-host misses (spec §11); JSON `{"error":…}` for `/api/*`. Missing _assets_ on the CDN host are R2's default 404 (OQ-07, human decision pending) — the Worker never sees them.                                                                                                                                                                                                                                                                               | §5, §11     |
| 409    | `slug_taken`                                                                                                                                                                                                           | User-supplied slug collides with an existing row (ADR 0007: auto-generated slugs never 409 — they get `-2`/`-3` suffixes; only explicit slugs conflict).                                                                                                                                                                                                                                                                                                                                                                                | S17/S18 AC  |
| 413    | `request_too_large`, `content_too_large`                                                                                                                                                                               | `request_too_large` — multipart body over the Worker guard (~95 MB; the platform's hard Free/Pro request-body limit is 100 MB — verified). `content_too_large` — pasted `content` over the 1 MB guard (OQ-17/T4). For multipart, returned before buffering when `Content-Length` is present; for chunked bodies, abort mid-buffer at the same threshold (protects the 128 MB Worker memory; `formData()` buffers the whole body — risk R6). For the JSON paste path, the guard is enforced **before storage** after the body is parsed. | §15, S17 AC |
| 422    | `entry_file_required`, `invalid_operation`                                                                                                                                                                             | Semantically invalid state transitions: deleting the entry file, PATCH on a nonexistent field, etc. (Distinct from 409: 409 = uniqueness conflict, 422 = operation invalid for the resource's state.)                                                                                                                                                                                                                                                                                                                                   | S18 AC      |
| 500    | `internal`                                                                                                                                                                                                             | Anything unexpected — the boundary converts it; never leaks stacks or internals.                                                                                                                                                                                                                                                                                                                                                                                                                                                        | S12 AC      |

> **Internal-invariant codes (S03, ADR 0012):** `invalid_rev` (500) and `unknown_action`
> (500) are thrown by pure modules (`rev.ts`) for invariant violations — an invalid rev or
> an unknown action type is a corrupt-row/caller bug, never client input. The boundary maps
> them to the generic `internal` 500; the codes exist for logs and tests. `path_traversal`
> (400, listed above) is the client-mappable code for rejected upload paths.

## Response shapes

- **Admin/API JSON** (all `/api/*` errors):
  ```json
  { "error": "slug_conflict", "message": "Slug \"notes\" is already taken." }
  ```
  `error` is the stable machine code (see taxonomy above). `message` is a safe,
  actionable human-readable string chosen at the throw site (OQ-15/T1, ADR 0036):
  the admin UI renders `message || error` verbatim, and the code never includes
  internal detail or stack traces (safety rule 2). The field is additive — code
  was `{ "error": "<code>" }` before T1; consumers must still key off `error`.
- **Public HTML**: clean 404 page for Worker-host misses; a minimal generic error page for
  5xx. Both `no-store`.
- **Redirects/entry**: success paths only; errors never carry cacheable headers (04).

## Safety rules

1. **Fail closed, never pass-open** (S16 AC): every JWT failure mode → 403; unset
   `ACCESS_AUD` → 403; JWKS fetch failure → 403; KV corruption → refetch → failure → 403.
2. **No stack leakage**: `detail` is logged server-side (`console.error`; optionally
   `ctx.waitUntil` batched logging), never echoed to the client.
3. **Errors are not cacheable**: 4xx/5xx responses are `no-store` (04). In particular the
   404-with-a-slug case must not poison the cache for a page created later.
4. **Purge failures are non-fatal** (04, S13 AC): a failed `ctx.cache.purge` logs and the
   mutation response still succeeds — the stale window is bounded by SWR headers.
5. **Validation happens before side effects** in mutating handlers: parse + validate the whole
   request, then write; partial D1/R2 failure triggers best-effort R2 rollback with no orphan
   rows (S17 AC).
6. **Malformed input never throws raw**: `classifyPath`, slug/id parsing, base injection,
   markdown rendering on bad input return errors/fallbacks, not crashes (S01/S04 AC; the
   boundary is the last resort, not the first).

## Cross-references

- Spec: §5 (404), §9 (auth), §10 (upload flows), §11 (other behavior), §15 (limits).
- Docs: [02 — Module boundaries](02-module-boundaries-contracts.md) (errors.ts contract),
  [04 — Caching & rev](04-caching-rev-model.md) (no-store rules),
  [06 — Test strategy](06-test-strategy.md) (error-path coverage).
- ADR: 0005 (error handling decision).
