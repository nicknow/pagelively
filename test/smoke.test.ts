import { env } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

// S12 smoke tests: prove the Worker boots in workerd with its bindings and the
// real public entry pipeline wired. Detailed behavior is covered in the
// slice-specific test files.
describe("Worker smoke", () => {
  const ctx = createExecutionContext();

  it("GET /health returns a public 200 JSON with no binding details", async () => {
    const res = await worker.fetch(new Request("https://pages.acme.com/health"), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, service: "pagelively" });
    expect(body).not.toHaveProperty("bindings");
  });

  it("GET / with HOME_MODE=404 returns a clean 404 page", async () => {
    const res = await worker.fetch(new Request("https://pages.acme.com/"), env, ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toContain("Not Found");
  });

  it("has the D1 migrations applied (schema from spec §8)", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('pages', 'files') ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["files", "pages"]);
  });
});
