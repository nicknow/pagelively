import { describe, expect, it } from "vitest";
import { CHARSET_HTML, isImageContentType, mimeTypeFor } from "../src/content-type";

// S06 AC 1–6 — Content-type mapping (spec §6, architecture 02 contract).
// Pure unit tests; no bindings.

/** Happy-path table: extension (case variants tested separately) → expected MIME. */
const HAPPY_PATH = [
  // Images
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["svg", "image/svg+xml"],
  ["avif", "image/avif"],
  // Styles / scripts
  ["css", "text/css"],
  ["js", "text/javascript"],
  // Fonts
  ["woff", "font/woff"],
  ["woff2", "font/woff2"],
  ["ttf", "font/ttf"],
  ["otf", "font/otf"],
  ["eot", "application/vnd.ms-fontobject"],
  // Documents
  ["md", "text/markdown"],
  ["html", CHARSET_HTML],
  ["htm", CHARSET_HTML],
] as const;

// ---------------------------------------------------------------------------
// Happy path (S06 AC 1): whitelist extensions map to the right MIME type.
// ---------------------------------------------------------------------------

describe("mimeTypeFor — whitelist mapping (S06 AC 1)", () => {
  it.each(HAPPY_PATH)("maps .%s to %s", (ext, expected) => {
    expect(mimeTypeFor(`file.${ext}`)).toBe(expected);
    expect(mimeTypeFor(`path/to/file.${ext}`)).toBe(expected);
  });

  it("exports the canonical HTML content type as CHARSET_HTML", () => {
    expect(CHARSET_HTML).toBe("text/html; charset=utf-8");
  });
});

// ---------------------------------------------------------------------------
// Edge cases (S06 AC 4): case-insensitivity, aliases, dotless, paths.
// ---------------------------------------------------------------------------

describe("mimeTypeFor — case-insensitive extension matching (S06 AC 3)", () => {
  it.each(HAPPY_PATH)("maps .%s uppercase to the same MIME type", (ext, expected) => {
    expect(mimeTypeFor(`file.${ext.toUpperCase()}`)).toBe(expected);
    expect(mimeTypeFor(`FILE.${ext.toUpperCase()}`)).toBe(expected);
    expect(mimeTypeFor(`path/to/File.${ext.toUpperCase()}`)).toBe(expected);
  });

  it("handles mixed-case extensions", () => {
    expect(mimeTypeFor("file.PnG")).toBe("image/png");
    expect(mimeTypeFor("file.HtMl")).toBe(CHARSET_HTML);
    expect(mimeTypeFor("file.Md")).toBe("text/markdown");
  });
});

describe("mimeTypeFor — extension aliases (S06 AC 4)", () => {
  it("maps .jpeg to image/jpeg", () => {
    expect(mimeTypeFor("file.jpeg")).toBe("image/jpeg");
  });

  it("maps .htm to text/html; charset=utf-8", () => {
    expect(mimeTypeFor("file.htm")).toBe(CHARSET_HTML);
  });

  it("maps .markdown to text/markdown", () => {
    expect(mimeTypeFor("file.markdown")).toBe("text/markdown");
  });
});

describe("mimeTypeFor — dotless and unknown filenames (S06 AC 2, AC 4)", () => {
  it("returns application/octet-stream for filenames with no extension", () => {
    expect(mimeTypeFor("README")).toBe("application/octet-stream");
    expect(mimeTypeFor("path/to/Makefile")).toBe("application/octet-stream");
    expect(mimeTypeFor("LICENSE")).toBe("application/octet-stream");
  });

  it("returns application/octet-stream for empty and degenerate extensions", () => {
    expect(mimeTypeFor("file.")).toBe("application/octet-stream");
    expect(mimeTypeFor(".")).toBe("application/octet-stream");
    expect(mimeTypeFor("..")).toBe("application/octet-stream");
    expect(mimeTypeFor(".gitignore")).toBe("application/octet-stream");
    expect(mimeTypeFor("path/.hidden")).toBe("application/octet-stream");
  });

  it("returns application/octet-stream for extensions not in the whitelist", () => {
    expect(mimeTypeFor("file.txt")).toBe("application/octet-stream");
    expect(mimeTypeFor("file.json")).toBe("application/octet-stream");
    expect(mimeTypeFor("file.pdf")).toBe("application/octet-stream");
    expect(mimeTypeFor("file.zip")).toBe("application/octet-stream");
    expect(mimeTypeFor("file.tar.gz")).toBe("application/octet-stream"); // last ext is .gz
  });

  it("uses the last extension segment for multi-dotted filenames", () => {
    expect(mimeTypeFor("file.md.txt")).toBe("application/octet-stream");
    expect(mimeTypeFor("file..md")).toBe("text/markdown");
    expect(mimeTypeFor("archive.tar.gz")).toBe("application/octet-stream");
  });

  it("ignores dots in directory names and extracts the file extension", () => {
    expect(mimeTypeFor("my.folder/file.png")).toBe("image/png");
    expect(mimeTypeFor("my.folder/file")).toBe("application/octet-stream");
  });

  it("strips query strings and fragments before extracting the extension", () => {
    expect(mimeTypeFor("file.png?cache=1")).toBe("image/png");
    expect(mimeTypeFor("file.png#fragment")).toBe("image/png");
    expect(mimeTypeFor("file.png?x=1#y")).toBe("image/png");
    expect(mimeTypeFor("file.txt?x=1")).toBe("application/octet-stream");
  });
});

// ---------------------------------------------------------------------------
// Failure mode (S06 AC 2): never throws, always returns a string.
// ---------------------------------------------------------------------------

describe("mimeTypeFor — failure mode (S06 AC 2, AC 6)", () => {
  it("never throws, even for empty or unusual input", () => {
    for (const input of ["", "/", "file", "file.", "...", "a/b/c", "file.png?", "file.png#"]) {
      expect(() => mimeTypeFor(input)).not.toThrow();
      expect(typeof mimeTypeFor(input)).toBe("string");
    }
  });

  it("returns application/octet-stream for an empty path", () => {
    expect(mimeTypeFor("")).toBe("application/octet-stream");
  });

  it("returns application/octet-stream for non-string inputs (total function)", () => {
    for (const input of [null, undefined, 123, {}, Symbol("x")]) {
      expect(() => mimeTypeFor(input as unknown as string)).not.toThrow();
      expect(mimeTypeFor(input as unknown as string)).toBe("application/octet-stream");
    }
  });
});

// ---------------------------------------------------------------------------
// Query/fragment stripping (S06 AC 5) and path-separator edge cases.
// ---------------------------------------------------------------------------

describe("mimeTypeFor — query/fragment stripping (S06 AC 5)", () => {
  it("strips query and fragment before extracting the extension", () => {
    expect(mimeTypeFor("foo.png?x=1#y")).toBe("image/png");
    expect(mimeTypeFor("foo.html?x=1")).toBe(CHARSET_HTML);
    expect(mimeTypeFor("foo.md#x")).toBe("text/markdown");
  });

  it("treats the first query/fragment delimiter as the URL separator", () => {
    // Query/fragment delimiters in the filename part end the path.
    expect(mimeTypeFor("file?name=foo.png")).toBe("application/octet-stream");
    expect(mimeTypeFor("foo?x.bar.png")).toBe("application/octet-stream");
  });

  it("ignores Windows-style path separators", () => {
    expect(mimeTypeFor("foo\\bar.png")).toBe("image/png");
    expect(mimeTypeFor("foo\\bar")).toBe("application/octet-stream");
  });
});

// ---------------------------------------------------------------------------
// Extra degenerate inputs the implementer suite did not cover.
// ---------------------------------------------------------------------------

describe("mimeTypeFor — degenerate filename probes", () => {
  it("handles a path that is only an extension segment", () => {
    expect(mimeTypeFor(".png")).toBe("image/png");
    expect(mimeTypeFor(".md")).toBe("text/markdown");
  });

  it("handles trailing dots and spaced extensions", () => {
    expect(mimeTypeFor("file.png.")).toBe("application/octet-stream");
    expect(mimeTypeFor("file. png")).toBe("application/octet-stream");
    expect(mimeTypeFor("file.png ")).toBe("application/octet-stream");
  });

  it("returns application/octet-stream for unicode extensions", () => {
    expect(mimeTypeFor("foo.中文")).toBe("application/octet-stream");
  });

  it("treats embedded null bytes as part of an unknown extension", () => {
    expect(mimeTypeFor("foo.png\u0000")).toBe("application/octet-stream");
    expect(mimeTypeFor("\u0000.png")).toBe("image/png");
  });
});

// ---------------------------------------------------------------------------
// Image helper (S06 AC 7): isImageContentType.
// ---------------------------------------------------------------------------

describe("isImageContentType (S06 AC 7)", () => {
  it("returns true for every image MIME type in the whitelist", () => {
    for (const [, mime] of HAPPY_PATH) {
      if (mime.startsWith("image/")) {
        expect(isImageContentType(mime)).toBe(true);
      }
    }
  });

  it("returns false for non-image content types", () => {
    expect(isImageContentType("text/html; charset=utf-8")).toBe(false);
    expect(isImageContentType("text/markdown")).toBe(false);
    expect(isImageContentType("text/css")).toBe(false);
    expect(isImageContentType("text/javascript")).toBe(false);
    expect(isImageContentType("font/woff")).toBe(false);
    expect(isImageContentType("application/vnd.ms-fontobject")).toBe(false);
    expect(isImageContentType("application/octet-stream")).toBe(false);
  });

  it("returns true for any image/* type, including unknown image types", () => {
    expect(isImageContentType("image/bmp")).toBe(true);
    expect(isImageContentType("image/tiff")).toBe(true);
  });

  it("returns false for non-image prefixes and malformed inputs", () => {
    expect(isImageContentType("")).toBe(false);
    expect(isImageContentType("image")).toBe(false);
    expect(isImageContentType("image/")).toBe(false);
    expect(isImageContentType("text/image")).toBe(false);
  });

  it("never throws, always returns a boolean", () => {
    for (const input of ["", "image/png", "text/html", "image/", "image", null, undefined, 123]) {
      expect(() => isImageContentType(input as string)).not.toThrow();
      expect(typeof isImageContentType(input as string)).toBe("boolean");
    }
  });
});
