/**
 * S23-C — Worker-side protected asset serving (ADR 0041 decision 6;
 * architecture 02 `serveAsset` contract).
 *
 * GET /assets/pages/{id}/{rev}/{path…} → the stored object bytes with the
 * stored content type. All responses use `headersFor("protected")` — no-store,
 * never a Cache-Tag (ADR 0041 decision 9). There is deliberately NO D1 read and
 * NO cookie check here: the route is only reachable through the injected
 * Worker-origin `<base>` of an unlocked page, and the R2 key embeds the
 * unguessable page id and rev (spec §8).
 *
 * Input discipline (ADR 0012): the id is validated, the rev must be a positive
 * integer string (URL input → 400, NOT the 500-class `requireValidRev`), the
 * raw path is percent-decoded (malformed encodings → clean 404, never 500) and
 * then checked with the shared `validateStoredPath` rule BEFORE any R2 key is
 * built — a decoded `../`, backslash, or `%` can never produce a key outside
 * the page prefix.
 */

import { AppError } from "./errors";
import { validateId } from "./ids";
import { classifyPath } from "./router";
import { clean404Response } from "./redirects";
import { validateStoredPath } from "./form-parser";
import type { ObjectStore } from "./object-store";
import type { CacheService } from "./cache-service";

export interface AssetServeDependencies {
  objects: Pick<ObjectStore, "get">;
  cache: CacheService;
}

/** Serves a classified `asset` route; other routes passed directly → clean 404. */
export async function serveAsset(
  request: Request,
  deps: AssetServeDependencies,
): Promise<Response> {
  const url = new URL(request.url);
  const route = classifyPath(url.pathname);
  if (route.type !== "asset") {
    return clean404Response(url);
  }

  if (!validateId(route.id)) {
    throw new AppError("invalid_id", 400, "Invalid page id.");
  }

  const rev = parseRev(route.rev);

  let path: string;
  try {
    path = decodeURIComponent(route.path);
  } catch {
    // Malformed percent-encoding can never be a stored path — clean 404, never 500.
    return clean404Response(url);
  }
  validateStoredPath(path);

  const stored = await deps.objects.get(route.id, rev, path);
  if (stored === null) {
    return clean404Response(url);
  }

  const headers = deps.cache.headersFor("protected");
  headers.set("Content-Type", stored.contentType);
  return new Response(stored.body, { headers });
}

/**
 * Rev is URL input (spec §8: a positive integer starting at 1). Rejects
 * anything that is not a plain decimal string representing a positive safe
 * integer with 400 `invalid_rev` — deliberately stricter than `Number()`
 * coercion and never the 500-class `requireValidRev` invariant guard.
 */
function parseRev(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw invalidRev(raw);
  }
  const rev = Number(raw);
  if (!Number.isSafeInteger(rev) || rev < 1) {
    throw invalidRev(raw);
  }
  return rev;
}

function invalidRev(raw: string): AppError {
  return new AppError(
    "invalid_rev",
    400,
    `Rev must be a positive integer (spec §8), got "${raw}".`,
  );
}
