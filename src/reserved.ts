/**
 * Reserved words — the single source of truth for the §5 reserved list and the
 * `isReservedName` predicate (ADR 0007 decision 2). The router (S01) and slug
 * validation (S02) both consume this module; never duplicate the list anywhere.
 *
 * Rules (ADR 0007): exact-match, case-insensitive, on the WHOLE first path
 * segment; `_` is the only prefix rule (future-internal names, §5.1).
 */

export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "p",
  "api",
  "admin",
  "assets",
  "favicon.ico",
  "robots.txt",
  "health",
  "sitemap.xml",
]);

export function isReservedName(name: string): boolean {
  // `_`-prefix reservation is case-insensitive by nature (underscores have no
  // case); the named entries compare case-insensitively on the whole segment.
  return name.startsWith("_") || RESERVED_NAMES.has(name.toLowerCase());
}
