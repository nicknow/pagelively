# 0015: S06 implementation details — content-type mapping

- Status: accepted
- Date: 2026-07-31

## Context

Slice S06 ("Content-type mapping") delivers `src/content-type.ts` — the pure-logic
extension → MIME table for the §6 asset whitelist (images, CSS, JS, fonts, Markdown,
HTML). The architecture 02 contract only names the slot ("MIME table (§6 whitelist + .md/.html;
extensible data)"); the concrete details left open were: the exact MIME string for each
extension, the handling of aliases (`.jpeg`, `.htm`, `.markdown`), case-insensitivity, the
fate of unknown/dotless files, whether query strings/fragments should be stripped, and the
shape of the helper used by S12 to recognize image pages.

## Decision

### 1. Whitelist table (`EXTENSION_TO_MIME`)

The table is a module-level `Record<string, string>` keyed by lowercase extension:

| Extension          | MIME type                       | Rationale                                                       |
| ------------------ | ------------------------------- | --------------------------------------------------------------- |
| `.png`             | `image/png`                     | spec §6                                                         |
| `.jpg`, `.jpeg`    | `image/jpeg`                    | spec §6 + `.jpeg` alias                                         |
| `.gif`             | `image/gif`                     | spec §6                                                         |
| `.webp`            | `image/webp`                    | spec §6                                                         |
| `.svg`             | `image/svg+xml`                 | spec §6                                                         |
| `.avif`            | `image/avif`                    | spec §6                                                         |
| `.css`             | `text/css`                      | spec §6                                                         |
| `.js`              | `text/javascript`               | RFC 9239 / modern HTML spec; `application/javascript` is legacy |
| `.woff`            | `font/woff`                     | spec §6                                                         |
| `.woff2`           | `font/woff2`                    | spec §6                                                         |
| `.ttf`             | `font/ttf`                      | spec §6                                                         |
| `.otf`             | `font/otf`                      | spec §6                                                         |
| `.eot`             | `application/vnd.ms-fontobject` | Legacy EOT font; no standard `font/eot` IANA type               |
| `.md`, `.markdown` | `text/markdown`                 | spec §6 raw Markdown source; no charset suffix                  |
| `.html`, `.htm`    | `text/html; charset=utf-8`      | spec §11; exported as `CHARSET_HTML`                            |

`CHARSET_HTML` is exported as a named constant so S12 can reference the canonical HTML
content type without duplicating the string.

### 2. `mimeTypeFor(path)` — lookup rules

- Strip any trailing query string (`?…`) and fragment (`#…`) before extension extraction.
  This is defensive: CDN-style URLs with cache-busting parameters still map correctly.
- Extract the segment after the **last** `.` in the path. Dots in directory names are
  ignored (e.g. `my.folder/file.png` → `.png`).
- Lowercase the extension before lookup; matching is case-insensitive (`.PNG`, `.Html`,
  `.MD` all work).
- Return the mapped MIME type, or `application/octet-stream` for dotless filenames,
  unknown extensions, and empty/degenerate extensions (`file.`, `.gitignore`).
- The function is total: it never throws. A defensive `typeof path !== "string"`
  guard returns `application/octet-stream` for non-string values that may leak in from
  multipart metadata or external callers, while all string inputs (including empty,
  dotless, and malformed paths) resolve safely.

### 3. `isImageContentType(contentType)` — helper for S12

Returns `true` if the content type is an `image/*` type with a non-empty subtype.
`image/svg+xml` is included; the bare prefix `image/` is not. The helper is exported now so
S12 can decide when a page entry is an image and issue the 301 redirect to the CDN asset
(spec §6, §11) without recomputing the MIME table.

## Consequences

- The table is data, not a switch chain, so adding a new asset type is a single table
  entry — satisfying the spec's "extensible whitelist" requirement (§6).
- Unknown file types are served as `application/octet-stream` rather than rejected; the
  upload layer (S17) will enforce the whitelist for newly published files, but the mapper
  itself is permissive and never throws.
- `text/html` always carries `charset=utf-8`; `.md` does not. This matches the spec: rendered
  Markdown is wrapped in HTML and served with `CHARSET_HTML`, while the raw `source.md` is
  served as plain `text/markdown`.
- `.js` uses `text/javascript` per the modern spec; `.eot` uses the legacy Microsoft MIME
  type. Both are documented in the table so future agents can see why the choice was made.
- Coverage: `src/content-type.ts` is fully branch-covered by the S06 table tests (60 tests;
  suite total 363; thresholds 85/85/80/85 exceeded).

## Cross-references

- Spec: §6 (asset whitelist / CDN serving), §11 (serving behavior, `text/html; charset=utf-8`).
- Docs: `docs/architecture/02` (contracts — `content-type.ts` slot), `docs/development/roadmap.md` S06.
- Code: `src/content-type.ts`, `test/content-type.test.ts`.
