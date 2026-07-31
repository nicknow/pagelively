/**
 * Route classification (spec §5, architecture 02 contract, ADR 0007/0010).
 * Pure and total: malformed paths return `unknown`, never throw — the caller
 * (S08/S12) decides 404 vs 301.
 *
 * The Route union uses the architecture's `health` member; this supersedes the
 * roadmap's planned `system` type.
 *
 * Decisions (ADR 0010):
 * - Trailing slashes (any number) are stripped before classification; the
 *   trailing-slash 301 logic is a later, separate step (S08).
 * - Reserved first segments never classify as slug (ADR 0007 decision 3: slug
 *   lookups never query a reserved word — guaranteed by construction).
 * - Reserved comparison is case-insensitive; the slug segment is lowercased
 *   (slugs are lowercase-only, OQ-02); the id segment is left RAW (ids are a
 *   case-sensitive namespace — never lowercase an id).
 * - `health` is a leaf route (only `/health[/]`); `admin` and `api` are
 *   prefixes; `/p/{id}` is exactly two segments (empty id or deeper paths →
 *   unknown — spec defines only `/p/{id}/`).
 * - Encoded slashes (`%2F`/`%2f`) anywhere → unknown: they must never be
 *   interpreted as separators (S08: no redirect loops on encoded slashes).
 * - Paths not starting with `/`, or containing empty internal segments →
 *   unknown.
 */

import { isReservedName } from "./reserved";

export type Route =
  | { type: "home" }
  | { type: "health" }
  | { type: "slug"; slug: string } // /{slug} or /{slug}/
  | { type: "id"; id: string } // /p/{id}/…
  | { type: "admin" } // /admin…  (Access-protected at edge)
  | { type: "api" } // /api/*    (Access-protected at edge)
  | { type: "unknown" };

const ENCODED_SLASH = /%(?:2f|2F)/;

export function classifyPath(pathname: string): Route {
  if (pathname === "/") {
    return { type: "home" };
  }
  if (!pathname.startsWith("/")) {
    return { type: "unknown" };
  }
  if (ENCODED_SLASH.test(pathname)) {
    return { type: "unknown" };
  }

  const trimmed = pathname.replace(/\/+$/, "");
  if (trimmed === "" || trimmed.includes("//")) {
    return { type: "unknown" };
  }

  const [first, ...rest] = trimmed.slice(1).split("/");
  const firstLower = first.toLowerCase();

  if (firstLower === "health") {
    return rest.length === 0 ? { type: "health" } : { type: "unknown" };
  }
  if (firstLower === "admin") {
    return { type: "admin" };
  }
  if (firstLower === "api") {
    return { type: "api" };
  }
  if (firstLower === "p") {
    // Id routes are exactly two segments: /p/{id}[/]. Empty id and deeper
    // paths are malformed for the id surface (spec §5, ADR 0010).
    if (rest.length !== 1) {
      return { type: "unknown" };
    }
    return { type: "id", id: rest[0] };
  }
  if (isReservedName(firstLower)) {
    return { type: "unknown" };
  }
  if (rest.length !== 0) {
    return { type: "unknown" };
  }
  return { type: "slug", slug: firstLower };
}
