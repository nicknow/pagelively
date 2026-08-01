/**
 * S12 — Typed, validated config accessor over `Env` (spec §12, architecture 02).
 *
 * `createConfig(env)` normalizes the raw string vars from `wrangler.toml` (or
 * `.dev.vars`) into the `AppConfig` shape the rest of the Worker uses. It is
 * deliberately minimal: it does not resolve pages or build responses, and it
 * keeps all env reads in one place.
 *
 * Normalization rules:
 * - `assetBaseUrl` strips any trailing slash so the base href builder always
 *   concatenates exactly one `/` between the host and `/pages/{id}/{rev}/`.
 * - `homeMode` is trimmed and lowercased; only the exact value `"page"`
 *   selects home-page mode — everything else is treated as `"404"` (fail-safe).
 * - `homePageSlug` is trimmed; empty/whitespace-only is stored as `null`.
 * - `allowRawHtmlInMd` is `true` unless the env value is literally `"false"`
 *   (case-insensitive, trimmed), matching the spec default of true.
 * - `access.teamDomainUrl` is built from the bare `ACCESS_TEAM_DOMAIN`: any
 *   `https://` prefix is removed first, then `https://` is prepended. Empty or
 *   missing values produce an empty string.
 * - `access.aud` is `null` when the value is empty or a placeholder (a string
 *   of only zeros), which tells the JWT gate to fail closed in S16.
 */

export interface AppConfig {
  siteName: string;
  assetBaseUrl: string; // validated URL, no trailing slash
  homeMode: "page" | "404";
  homePageSlug: string | null;
  allowRawHtmlInMd: boolean;
  access: {
    teamDomainUrl: string;
    aud: string | null;
  };
}

function isPlaceholderAud(value: string): boolean {
  // A common placeholder is a string of zeros of any length.
  return value.length > 0 && /^0+$/.test(value);
}

export function createConfig(env: Env): AppConfig {
  const assetBaseUrl = String(env.ASSET_BASE_URL ?? "").replace(/\/+$/, "");

  const homeModeRaw = String(env.HOME_MODE ?? "404")
    .trim()
    .toLowerCase();
  const homeMode = homeModeRaw === "page" ? "page" : "404";

  const rawSlug = env.HOME_PAGE_SLUG === undefined ? "" : String(env.HOME_PAGE_SLUG).trim();
  const homePageSlug = homeMode === "page" && rawSlug !== "" ? rawSlug : null;

  const allowRawValue = String(env.ALLOW_RAW_HTML_IN_MD ?? "true")
    .trim()
    .toLowerCase();
  const allowRawHtmlInMd = allowRawValue !== "false";

  const teamDomain = String(env.ACCESS_TEAM_DOMAIN ?? "").trim();
  const teamDomainUrl =
    teamDomain === ""
      ? ""
      : `https://${teamDomain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`;

  const rawAud = String(env.ACCESS_AUD ?? "").trim();
  const aud = rawAud === "" || isPlaceholderAud(rawAud) ? null : rawAud;

  return {
    siteName: String(env.SITE_NAME ?? "Pagelively"),
    assetBaseUrl,
    homeMode,
    homePageSlug,
    allowRawHtmlInMd,
    access: {
      teamDomainUrl,
      aud,
    },
  };
}
