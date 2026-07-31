import { describe, expect, it } from "vitest";
import { RESERVED_NAMES, isReservedName } from "../src/reserved";
import { isReservedName as slugIsReservedName } from "../src/slug";

// S01 AC 5 — single source of the reserved list + predicate (ADR 0007).
// S02 expands validation on top of this; router.ts consumes it too.

describe("RESERVED_NAMES", () => {
  it("contains exactly the spec §5 names (ADR 0007 decision 2)", () => {
    expect([...RESERVED_NAMES].sort()).toEqual(
      ["admin", "api", "assets", "favicon.ico", "health", "p", "robots.txt", "sitemap.xml"].sort(),
    );
  });
});

describe("isReservedName", () => {
  it("returns true for every reserved name, case-insensitively", () => {
    for (const name of RESERVED_NAMES) {
      expect(isReservedName(name)).toBe(true);
      expect(isReservedName(name.toUpperCase())).toBe(true);
      expect(isReservedName(name.charAt(0).toUpperCase() + name.slice(1))).toBe(true);
    }
  });

  it("returns true for any underscore-prefixed segment (ADR 0007: _ is the only prefix rule)", () => {
    expect(isReservedName("_pages")).toBe(true);
    expect(isReservedName("_")).toBe(true);
    expect(isReservedName("_DRAFT")).toBe(true);
  });

  it("returns false for near-misses and ordinary names (exact whole-segment match)", () => {
    for (const name of [
      "admin2",
      "p-2",
      "pages",
      "api2",
      "favicon",
      "robots",
      "health-check",
      "healthz",
      "sitemap",
      "my-post",
    ]) {
      expect(isReservedName(name)).toBe(false);
    }
  });

  it("returns false for the empty string", () => {
    expect(isReservedName("")).toBe(false);
  });

  it("is re-exported from slug.ts for S02 without duplicating the source", () => {
    expect(slugIsReservedName).toBe(isReservedName);
  });
});

// --- validator additions (edge/regression, S01) ---

describe("isReservedName — validator edge cases", () => {
  it("requires the exact whole segment: decorations are NOT reserved", () => {
    for (const name of [
      "admin.",
      "admin ",
      ".admin",
      "favicon.ico2",
      "robots.txt/",
      "sitemap.xml?x=1",
      "health/extra",
      "p/p",
    ]) {
      expect(isReservedName(name)).toBe(false);
    }
  });

  it("stays exact even when case-shifted decorations are added", () => {
    expect(isReservedName("ADMIN.")).toBe(false);
    expect(isReservedName("Admin_2")).toBe(false);
  });

  it("treats every underscore-prefixed segment as reserved, including bare underscores", () => {
    expect(isReservedName("_")).toBe(true);
    expect(isReservedName("__init")).toBe(true);
    expect(isReservedName("_pages/foo")).toBe(true);
  });
});
