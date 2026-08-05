import { describe, expect, it, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { createSettingsRepository } from "../src/settings-repository";

describe("SettingsRepository", () => {
  const db = () => env.DB;

  beforeEach(async () => {
    await db().prepare("DELETE FROM settings").run();
  });

  it("get returns null for a non-existent key", async () => {
    const repo = createSettingsRepository(db());
    const value = await repo.get("nonexistent");
    expect(value).toBeNull();
  });

  it("set and get a value", async () => {
    const repo = createSettingsRepository(db());
    await repo.set("default_page", "my-page");
    const value = await repo.get("default_page");
    expect(value).toBe("my-page");
  });

  it("set overwrites an existing value (upsert)", async () => {
    const repo = createSettingsRepository(db());
    await repo.set("default_page", "first");
    await repo.set("default_page", "second");
    const value = await repo.get("default_page");
    expect(value).toBe("second");
  });

  it("getAll returns all settings as a record", async () => {
    const repo = createSettingsRepository(db());
    await repo.set("default_page", "home");
    await repo.set("theme", "dark");
    const all = await repo.getAll();
    expect(all).toEqual({ default_page: "home", theme: "dark" });
  });

  it("getAll returns empty object when no settings exist", async () => {
    const repo = createSettingsRepository(db());
    const all = await repo.getAll();
    expect(all).toEqual({});
  });
});
