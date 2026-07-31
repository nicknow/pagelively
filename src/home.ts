/**
 * S09 — Home-mode resolution (spec §11, OQ-08, ADR 0018).
 *
 * `resolveHome` is a pure decision function. It returns either the slug that
 * should be served at `/` or a 404 decision. It deliberately does not build a
 * Response, does not read D1, and does not call the 404 renderer — those are
 * S12's responsibilities. The function is total: every possible input maps to a
 * closed `HomeResolution` union.
 *
 * Fail-safe behavior: any unrecognised `HOME_MODE` value (including unset,
 * null, empty, whitespace-only, or garbage) and any invalid/missing slug when
 * mode is `page` result in `{ type: "404" }`. Specific validation errors from
 * `validateSlug` are swallowed; they simply mean "treat the home as missing".
 */

import { validateSlug } from "./slug";

export type HomeResolution = { type: "page"; slug: string } | { type: "404" };

function normalizeMode(homeMode: string | null | undefined): string {
  if (typeof homeMode !== "string") {
    return "";
  }
  return homeMode.trim().toLowerCase();
}

/**
 * Decide what `/` should serve.
 *
 * @param homeMode — raw `HOME_MODE` value (validated here regardless of any
 *   upstream normalization).
 * @param homePageSlug — raw `HOME_PAGE_SLUG` value (validated here).
 * @returns `{ type: "page", slug }` when mode is `page` and the slug passes
 *   `validateSlug`; otherwise `{ type: "404" }`.
 */
export function resolveHome(
  homeMode: string | null | undefined,
  homePageSlug: string | null | undefined,
): HomeResolution {
  if (normalizeMode(homeMode) !== "page") {
    return { type: "404" };
  }

  if (typeof homePageSlug !== "string" || homePageSlug === "") {
    return { type: "404" };
  }

  const validation = validateSlug(homePageSlug);
  if (!validation.ok) {
    return { type: "404" };
  }

  return { type: "page", slug: homePageSlug };
}
