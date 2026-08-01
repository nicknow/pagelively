/**
 * Rev handling: bump policy and the R2 key layout (spec §8, ADR 0006/0012,
 * architecture 04 purge matrix). Pure module — no bindings.
 *
 * `rev` is a per-publish revision counter: a positive integer starting at 1
 * (spec §8 DEFAULT 1). It is the cache-busting dimension — entry HTML and the
 * injected `<base>` href embed it, and R2 objects under `pages/{id}/{rev}/…`
 * are immutable-by-URL (ADR 0006). Rev invariants are correctness-critical:
 * invalid input THROWS (fail-fast) rather than degrading silently.
 *
 * `buildR2Key` is the ONLY place keys are constructed (architecture 02); the
 * `pages/{id}/{rev}/{path}` layout is a hard contract — never invent a
 * parallel one. The builder is defensive about the path segment:
 * - normalizes `//` and `./` segments, strips trailing slashes, collapses
 *   non-escaping `..` (ADR 0012 d4: only paths that ESCAPE the page prefix are
 *   rejected);
 * - rejects escapes (`../x`, `a/../../b`), absolute paths, and paths that
 *   normalize to empty — typed `AppError("path_traversal", 400)`, never a
 *   silently-produced key outside the namespace;
 * - treats paths as ALREADY-DECODED strings: `%`-sequences and `\` are literal
 *   characters, never decoded or reinterpreted here (ADR 0012 d5 — write-side
 *   `../` rejection at the upload layer, S17, is the front line).
 * The page id is NOT re-validated here: `validateId` owns that at the API
 * boundary (ADR 0010), and the id charset contains no `.` or `/`, so an id
 * cannot traverse.
 *
 * `shouldBumpRev` models the purge matrix's bump policy as a discriminated
 * union: content-affecting actions (file add/replace, file delete, entry
 * change, markdown re-render) bump; metadata edits (slug/title/visibility/
 * show_source) and create do not (they are covered by tag purge; a slug
 * change yields identical entry HTML because `<base>` and template links are
 * serve-time/relative — ADR 0008, ADR 0012). An unknown action type THROWS —
 * never silently no-bump (planner AC failure case).
 */

import { AppError } from "./errors";

/** A mutation/action on a page, as seen by the rev-bump policy (ADR 0012). */
export type RevAction =
  | { type: "file-add" } // add or replace a file
  | { type: "file-delete" }
  | { type: "entry-change" } // entry document content changed
  | { type: "re-render" } // markdown re-render (template changes, OQ-13)
  | { type: "slug-edit" } // PATCH slug (metadata — does NOT bump)
  | { type: "meta-edit" } // PATCH title/visibility/show_source (no bump)
  | { type: "create" }; // new page — rev starts at 1 (§8 DEFAULT 1)

/** Guards the rev invariant shared by nextRev and buildR2Key. */
export function requireValidRev(rev: number): void {
  // Number.isInteger rejects floats, NaN, ±Infinity AND non-numbers (JS
  // interop); `rev < 1` rejects 0 and negatives (spec §8: starts at 1).
  if (!Number.isInteger(rev) || rev < 1) {
    throw new AppError(
      "invalid_rev",
      500,
      `Rev must be a positive integer (spec §8), got ${String(rev)}.`,
    );
  }
}

/** The next publish revision: a positive integer + 1 (S03 AC 1). */
export function nextRev(current: number): number {
  requireValidRev(current);
  return current + 1;
}

/**
 * Builds an R2 key: `pages/{id}/{rev}/{path}` (spec §8). Paths are normalized
 * and escape-checked per the module docstring (S03 AC 2 & 3).
 */
export function buildR2Key(pageId: string, rev: number, path: string): string {
  requireValidRev(rev);
  if (path.startsWith("/")) {
    throw pathTraversal(`Path must be relative (no leading "/"): "${path}".`);
  }
  const segments = path.split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue; // collapse `//` and `./`
    if (segment === "..") {
      if (normalized.length === 0) {
        throw pathTraversal(`Path escapes the page prefix (".."): "${path}".`);
      }
      normalized.pop();
    } else {
      normalized.push(segment);
    }
  }
  if (normalized.length === 0) {
    throw pathTraversal(`Path must name at least one file: "${path}".`);
  }
  return `pages/${pageId}/${rev}/${normalized.join("/")}`;
}

function pathTraversal(publicMessage: string): AppError {
  // architecture 05 taxonomy: `path_traversal` under 400.
  return new AppError("path_traversal", 400, publicMessage);
}

/**
 * Bump policy per the purge matrix (architecture 04, OQ-04, ADR 0012).
 * True only for content-affecting actions; throws on anything else.
 */
export function shouldBumpRev(action: RevAction): boolean {
  // Runtime shape guard: JS interop may pass a non-object; dereferencing
  // `.type` on it would throw a raw TypeError before our typed error.
  if (typeof action !== "object" || action === null) {
    throw new AppError("unknown_action", 500, `Unknown rev action: ${String(action)}.`);
  }
  // Read the label once: the switch cases below are literal comparisons, so
  // anything unknown/missing/non-string lands in `default` (fail-fast).
  const type: unknown = action.type;
  switch (type) {
    case "file-add":
    case "file-delete":
    case "entry-change":
    case "re-render":
      return true;
    case "slug-edit":
    case "meta-edit":
    case "create":
      return false;
    default:
      // Never silently no-bump (planner AC failure case). Exhaustiveness of
      // the union is enforced at runtime by this throw + the unknown-action
      // tests: adding a member to RevAction without a case here fails loudly
      // instead of corrupting the rev sequence (ADR 0012 d3).
      throw new AppError("unknown_action", 500, `Unknown rev action: ${String(type)}.`);
  }
}
