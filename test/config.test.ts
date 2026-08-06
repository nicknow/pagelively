import { describe, expect, it } from "vitest";
import { createConfig, type AppConfig } from "../src/config";

// S12 — Env normalization for the public entry pipeline.

function env(overrides: Record<string, string | undefined> = {}): Env {
  return {
    SITE_NAME: "Pagelively",
    ASSET_BASE_URL: "https://cdn.example.com",
    HOME_MODE: "404",
    HOME_PAGE_SLUG: "",
    ALLOW_RAW_HTML_IN_MD: "true",
    PUBLIC_LISTING: "false",
    ACCESS_TEAM_DOMAIN: "yourteam.cloudflareaccess.com",
    ACCESS_AUD: "00000000000000000000000000000000000000000000000000",
    DB: {} as D1Database,
    BUCKET: {} as R2Bucket,
    ...overrides,
  } as Env;
}

describe("createConfig", () => {
  it("uses defaults and normalizes the default env", () => {
    const c = createConfig(env());
    expect(c).toEqual({
      siteName: "Pagelively",
      assetBaseUrl: "https://cdn.example.com",
      homeMode: "404",
      homePageSlug: null,
      allowRawHtmlInMd: true,
      access: {
        teamDomainUrl: "https://yourteam.cloudflareaccess.com",
        aud: null,
      },
    } as AppConfig);
  });

  it("strips trailing slashes from assetBaseUrl", () => {
    expect(createConfig(env({ ASSET_BASE_URL: "https://cdn.example.com/" })).assetBaseUrl).toBe(
      "https://cdn.example.com",
    );
    expect(createConfig(env({ ASSET_BASE_URL: "https://cdn.example.com///" })).assetBaseUrl).toBe(
      "https://cdn.example.com",
    );
  });

  it("normalizes HOME_MODE to page or 404", () => {
    expect(createConfig(env({ HOME_MODE: "page" })).homeMode).toBe("page");
    expect(createConfig(env({ HOME_MODE: "PAGE" })).homeMode).toBe("page");
    expect(createConfig(env({ HOME_MODE: "  page  " })).homeMode).toBe("page");
    expect(createConfig(env({ HOME_MODE: "" })).homeMode).toBe("404");
    expect(createConfig(env({ HOME_MODE: "garbage" })).homeMode).toBe("404");
  });

  it("trims homePageSlug and stores empty as null", () => {
    expect(createConfig(env({ HOME_MODE: "page", HOME_PAGE_SLUG: "hello" })).homePageSlug).toBe(
      "hello",
    );
    expect(createConfig(env({ HOME_MODE: "page", HOME_PAGE_SLUG: " hello " })).homePageSlug).toBe(
      "hello",
    );
    expect(createConfig(env({ HOME_MODE: "page", HOME_PAGE_SLUG: "" })).homePageSlug).toBeNull();
    expect(createConfig(env({ HOME_MODE: "page", HOME_PAGE_SLUG: "   " })).homePageSlug).toBeNull();
  });

  it("homeMode=404 ignores HOME_PAGE_SLUG", () => {
    expect(
      createConfig(env({ HOME_MODE: "404", HOME_PAGE_SLUG: "hello" })).homePageSlug,
    ).toBeNull();
  });

  it("parses allowRawHtmlInMd as true unless the value is false", () => {
    expect(createConfig(env({ ALLOW_RAW_HTML_IN_MD: "true" })).allowRawHtmlInMd).toBe(true);
    expect(createConfig(env({ ALLOW_RAW_HTML_IN_MD: "false" })).allowRawHtmlInMd).toBe(false);
    expect(createConfig(env({ ALLOW_RAW_HTML_IN_MD: "FALSE" })).allowRawHtmlInMd).toBe(false);
    expect(createConfig(env({ ALLOW_RAW_HTML_IN_MD: "yes" })).allowRawHtmlInMd).toBe(true);
    expect(createConfig(env({ ALLOW_RAW_HTML_IN_MD: "" })).allowRawHtmlInMd).toBe(true);
  });

  it("builds teamDomainUrl from a bare domain", () => {
    expect(
      createConfig(env({ ACCESS_TEAM_DOMAIN: "myteam.cloudflareaccess.com" })).access.teamDomainUrl,
    ).toBe("https://myteam.cloudflareaccess.com");
  });

  it("strips scheme and trailing slashes from teamDomainUrl", () => {
    expect(
      createConfig(env({ ACCESS_TEAM_DOMAIN: "https://myteam.cloudflareaccess.com/" })).access
        .teamDomainUrl,
    ).toBe("https://myteam.cloudflareaccess.com");
  });

  it("strips http:// prefix identically to https:// from teamDomainUrl", () => {
    expect(
      createConfig(env({ ACCESS_TEAM_DOMAIN: "http://myteam.cloudflareaccess.com" })).access
        .teamDomainUrl,
    ).toBe("https://myteam.cloudflareaccess.com");
    expect(
      createConfig(env({ ACCESS_TEAM_DOMAIN: "http://myteam.cloudflareaccess.com/" })).access
        .teamDomainUrl,
    ).toBe("https://myteam.cloudflareaccess.com");
  });

  it("uses an empty teamDomainUrl when ACCESS_TEAM_DOMAIN is whitespace-only", () => {
    expect(createConfig(env({ ACCESS_TEAM_DOMAIN: "   " })).access.teamDomainUrl).toBe("");
  });

  it("treats a single-character zero AUD as placeholder (null)", () => {
    expect(createConfig(env({ ACCESS_AUD: "0" })).access.aud).toBeNull();
  });

  it("uses an empty teamDomainUrl when ACCESS_TEAM_DOMAIN is missing", () => {
    expect(createConfig(env({ ACCESS_TEAM_DOMAIN: undefined })).access.teamDomainUrl).toBe("");
  });

  it("treats an all-zero AUD as null", () => {
    expect(
      createConfig(env({ ACCESS_AUD: "00000000000000000000000000000000000000000000000000" })).access
        .aud,
    ).toBeNull();
  });

  it("treats an empty AUD as null", () => {
    expect(createConfig(env({ ACCESS_AUD: "" })).access.aud).toBeNull();
  });

  it("keeps a non-placeholder AUD value", () => {
    expect(createConfig(env({ ACCESS_AUD: "abc123" })).access.aud).toBe("abc123");
  });

  it("uses default siteName when SITE_NAME is missing", () => {
    expect(createConfig(env({ SITE_NAME: undefined })).siteName).toBe("Pagelively");
  });

  it("covers default branches for optional env vars", () => {
    const c = createConfig({
      ...env(),
      ASSET_BASE_URL: undefined,
      HOME_MODE: undefined,
      HOME_PAGE_SLUG: undefined,
      ALLOW_RAW_HTML_IN_MD: undefined,
      ACCESS_AUD: undefined,
    } as unknown as Env);
    expect(c.assetBaseUrl).toBe("");
    expect(c.homeMode).toBe("404");
    expect(c.homePageSlug).toBeNull();
    expect(c.allowRawHtmlInMd).toBe(true);
    expect(c.access.aud).toBeNull();
  });
});
