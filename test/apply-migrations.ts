// Applies the real D1 migrations (from migrations/) to each test file's
// isolated local database, so tests assert against the actual schema.
// Recipe: https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/
// Vitest setup files are plain module side effects — the top-level await runs
// when this file is imported by the test pool (an exported function would never
// be called).
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
