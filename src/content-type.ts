/**
 * S06 — Content-type mapping (spec §6, architecture 02 contract).
 *
 * Pure module: path string → MIME type string. No bindings, no I/O, never throws.
 * The whitelist table is data (a `Record<string, string>`) so it is trivial to
 * extend when the spec's allowed asset types grow (spec §6 "extensible").
 *
 * Contract:
 * - `mimeTypeFor(path)` extracts the last segment after the final `.` (the
 *   filename extension), lowercases it, and looks it up in the whitelist table.
 * - Case-insensitive: `.PNG`, `.HTML`, `.Md` all resolve identically.
 * - Query strings and fragments are stripped before extension extraction so a
 *   CDN-style URL with cache-busting parameters still maps correctly.
 * - Dotless filenames, unknown extensions, and empty/degenerate extensions all
 *   return `application/octet-stream` (S06 AC 2: never throws).
 * - `CHARSET_HTML` is exported as the canonical HTML content type
 *   (`text/html; charset=utf-8`) so later slices (S12) can reference it directly.
 * - `isImageContentType(contentType)` returns true for any `image/*` type;
 *   this lets S12 decide whether a page entry is an image and issue the 301
 *   redirect to the CDN asset (spec §6, §11).
 */

/** Canonical HTML content type used by S12 (spec §11). */
export const CHARSET_HTML = "text/html; charset=utf-8";

/**
 * Whitelisted extension → MIME type table (spec §6, architecture 02).
 * Keys are lowercase extensions; the lookup lowercases the input extension.
 */
const EXTENSION_TO_MIME: Record<string, string> = {
  // Images
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",

  // Styles / scripts
  css: "text/css",
  js: "text/javascript",

  // Fonts
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",

  // Documents
  md: "text/markdown",
  markdown: "text/markdown",
  html: CHARSET_HTML,
  htm: CHARSET_HTML,
};

/**
 * Returns the MIME type for a file path. The result is always a string:
 * a mapped content type for whitelist extensions, or
 * `application/octet-stream` for unknown/dotless extensions.
 */
export function mimeTypeFor(path: string): string {
  // Defensive: this function is used on values that may come from multipart
  // metadata or external input. Treat any non-string as an unknown binary blob.
  if (typeof path !== "string") {
    return "application/octet-stream";
  }

  // Strip any query string or fragment before looking at the filename.
  // This keeps CDN-style URLs such as `file.png?cache=1` mapping correctly.
  let name = path;
  const queryIndex = name.indexOf("?");
  if (queryIndex !== -1) {
    name = name.slice(0, queryIndex);
  }
  const fragmentIndex = name.indexOf("#");
  if (fragmentIndex !== -1) {
    name = name.slice(0, fragmentIndex);
  }

  const lastDot = name.lastIndexOf(".");
  if (lastDot === -1 || lastDot === name.length - 1) {
    return "application/octet-stream";
  }

  const extension = name.slice(lastDot + 1).toLowerCase();
  return EXTENSION_TO_MIME[extension] ?? "application/octet-stream";
}

/** Returns true if `contentType` is an image type (`image/*` with a non-empty subtype). */
export function isImageContentType(contentType: string): boolean {
  return (
    typeof contentType === "string" &&
    contentType.startsWith("image/") &&
    contentType.length > "image/".length
  );
}
