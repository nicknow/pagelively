import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * Workers Vitest integration — Cloudflare's recommended unit-test tooling.
 * Tests run inside `workerd` (via Miniflare) and get real bindings emulated
 * locally: R2, D1, vars, etc. See
 * https://developers.cloudflare.com/workers/testing/vitest-integration/
 *
 * D1: the real migrations from `migrations/` are read once here and applied to
 * each test file's isolated local database in `test/apply-migrations.ts`.
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(import.meta.dirname, "migrations");
      const migrations = await readD1Migrations(migrationsPath);
      return {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          // Test-only binding so the setup file can apply migrations per test file.
          bindings: { TEST_MIGRATIONS: migrations },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
    coverage: {
      // Must be "istanbul": the Workers pool rejects the v8 provider because
      // V8 native coverage needs `node:inspector`, which is not functional in
      // the Workers runtime (see @cloudflare/vitest-pool-workers source).
      provider: "istanbul",
      reporter: ["text", "json-summary", "html"],
      include: ["src/**"],
      // Placeholder threshold — the architecture phase (Phase 2) sets the agreed
      // project-wide threshold and records it as an ADR.
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
