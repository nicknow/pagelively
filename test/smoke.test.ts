import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

// Phase 0 toolchain smoke tests: prove the Worker boots in workerd with its
// bindings emulated and the D1 schema applied. Real behavior tests start with
// the first feature slice.
describe("Phase 0 toolchain smoke", () => {
  it("boots the worker and reports healthy with bindings present", async () => {
    const res = await worker.fetch(new Request("https://pages.acme.com/health"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; bindings: { d1: boolean; r2: boolean } };
    expect(body.ok).toBe(true);
    expect(body.bindings).toEqual({ d1: true, r2: true });
  });

  it("serves the placeholder root page", async () => {
    const res = await worker.fetch(new Request("https://pages.acme.com/"), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Pagelively");
  });

  it("has the D1 migrations applied (schema from spec §8)", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('pages', 'files') ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["files", "pages"]);
  });
});
