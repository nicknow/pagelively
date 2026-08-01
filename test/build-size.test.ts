import { describe, expect, it } from "vitest";

// S22 — build size gate.
//
// The free-tier Worker size limits are 3 MB compressed and 64 MB uncompressed
// (verified 2026-08-01 via cfdocs; roadmap §6 / ADR 0031). `dist/` is
// gitignored, so in a fresh clone there is no bundle yet — the gate skips
// gracefully and the quickstart verifies the build separately via
// `npm run build`.
//
// The bundle is read through Vite's `?raw` loader (`import.meta.glob`) because
// the workerd test runtime has no host-filesystem access (`node:fs` there is a
// virtual, per-request filesystem — see ADR 0031). The glob is resolved at
// transform time: it matches nothing when `dist/` is absent, so the gate
// skips instead of failing the suite.

const distEntries = import.meta.glob("../dist/*.js", {
  query: "?raw",
  import: "default",
  eager: false,
}) as Record<string, () => Promise<string>>;

const distIndexLoader = distEntries["../dist/index.js"];

describe("S22 — build size gate", () => {
  it.runIf(distIndexLoader)(
    "dist/index.js fits the free-tier limits (3 MB compressed, 64 MB raw)",
    async () => {
      const { gzipSync } = await import("node:zlib");
      const raw = await distIndexLoader();
      const bytes = new TextEncoder().encode(raw);
      const compressed = gzipSync(bytes);

      // Guard against a broken/empty build quietly passing the size checks.
      expect(bytes.length).toBeGreaterThan(0);

      expect(bytes.length).toBeLessThan(64 * 1024 * 1024);
      expect(compressed.length).toBeLessThan(3 * 1024 * 1024);

      // Surface the measured sizes for the operator checklist and ADR 0031.
      console.log(
        `dist/index.js: ${bytes.length} bytes raw / ${compressed.length} bytes gzip ` +
          `(${(bytes.length / 1024).toFixed(2)} KiB / ${(compressed.length / 1024).toFixed(2)} KiB)`,
      );
    },
  );
});
