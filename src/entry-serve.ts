/**
 * S12 — Entry serving pipeline (spec §5, §6, §11; architecture 02).
 *
 * Resolves a slug or id to a page row via D1, then:
 * - S23-C: protected pages (password_hash set) show the inline password prompt
 *   until a valid `pl_unlock` cookie is presented (ADR 0041 decision 3).
 * - unlocked protected pages → Worker-served bytes with a Worker-origin base
 *   href; protected images are served as bytes, never a 301 to the CDN
 *   (ADR 0041 decision 6).
 * - public image pages → 301 redirect to the CDN object.
 * - public html / markdown / bundle pages → fetch the entry HTML from R2,
 *   inject the `<base href="{ASSET_BASE_URL}/pages/{id}/{rev}/{entry_path}">`
 *   tag, and return it with entry cache headers.
 *
 * Markdown entries are already rendered to HTML at publish time (S17), so this
 * layer does not need the markdown renderer; the dependency slot is reserved
 * in the interface for the future upload pipeline.
 */

import type { AppConfig } from "./config";
import type { PagesRepository } from "./pages-repository";
import type { ObjectStore } from "./object-store";
import type { CacheService } from "./cache-service";
import type { UnlocksRepository } from "./unlocks-repository";
import { AppError } from "./errors";
import { classifyPath } from "./router";
import { clean404Response } from "./redirects";
import { injectBase } from "./base-inject";
import { renderPasswordPrompt } from "./password-prompt";
import { hasValidUnlockCookie } from "./unlock";

export interface EntryServeDependencies {
  config: AppConfig;
  pages: Pick<PagesRepository, "getById" | "getBySlug">;
  /** S23-C: the unlock-row seam for the public password gate (ADR 0041 decision 3). */
  unlocks: Pick<UnlocksRepository, "getByPageId">;
  objects: Pick<ObjectStore, "get">;
  cache: CacheService;
  /** Reserved for S17; not used for serving. */
  markdown?: unknown;
}

/** Build the CDN base href for a page, pointing at the entry file itself. */
function buildBaseHref(config: AppConfig, pageId: string, rev: number, entryPath: string): string {
  return `${config.assetBaseUrl}/pages/${pageId}/${rev}/${entryPath}`;
}

/**
 * S23-C: the base href for an UNLOCKED protected page points back at this
 * Worker's `/assets/pages/{id}/{rev}/{entry}` route — never at the CDN, whose
 * object URLs bypass the password gate (ADR 0041 decision 6).
 */
function buildProtectedBaseHref(
  request: Request,
  page: { id: string; rev: number; entry_path: string },
): string {
  const origin = new URL(request.url).origin;
  return `${origin}/assets/pages/${page.id}/${page.rev}/${page.entry_path}`;
}

/**
 * Serve the entry for a `/{slug}/` or `/p/{id}/` request.
 *
 * Returns the entry HTML, a 301 to the CDN image, or a clean 404. Unexpected
 * non-AppError failures are converted to a generic 500 with no stack leakage.
 */
export async function serveEntry(
  request: Request,
  deps: EntryServeDependencies,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const route = classifyPath(url.pathname);

    if (route.type !== "slug" && route.type !== "id") {
      return clean404Response(url);
    }

    const page =
      route.type === "slug"
        ? await deps.pages.getBySlug(route.slug)
        : await deps.pages.getById(route.id);

    if (!page) {
      return clean404Response(url);
    }

    // S23 gate (ADR 0041 decision 3): a protected page shows the inline prompt
    // until a valid unlock cookie is presented. No R2 read, no title or content
    // disclosure — the prompt is generic and site-branded only (decision 5).
    if (page.password_hash !== null) {
      const unlocked = await hasValidUnlockCookie(request, page.id, deps.unlocks);
      if (!unlocked) {
        const headers = deps.cache.headersFor("protected");
        headers.set("Content-Type", "text/html; charset=utf-8");
        const body = renderPasswordPrompt({
          siteName: deps.config.siteName,
          action: `/p/${page.id}/unlock`,
        });
        return new Response(body, { status: 200, headers });
      }
    }

    // Unlocked protected surfaces never reference the CDN (see buildProtectedBaseHref).
    const baseHref =
      page.password_hash !== null
        ? buildProtectedBaseHref(request, page)
        : buildBaseHref(deps.config, page.id, page.rev, page.entry_path);

    if (page.kind === "image") {
      if (page.password_hash !== null) {
        // Protected images are served as Worker bytes — a 301 to the CDN would
        // leak the object URL and bypass the gate (ADR 0041 decision 6).
        const stored = await deps.objects.get(page.id, page.rev, page.entry_path);
        if (!stored) {
          return clean404Response(url);
        }
        const headers = deps.cache.headersFor("protected");
        headers.set("Content-Type", stored.contentType);
        return new Response(stored.body, { headers });
      }
      const headers = deps.cache.headersFor("redirect", page.id);
      headers.set("Location", baseHref);
      return new Response(null, { status: 301, headers });
    }

    const stored = await deps.objects.get(page.id, page.rev, page.entry_path);
    if (!stored) {
      return clean404Response(url);
    }

    const html = await new Response(stored.body).text();
    const body = injectBase(html, baseHref);
    const headers =
      page.password_hash !== null
        ? deps.cache.headersFor("protected")
        : deps.cache.headersFor("entry", page.id);
    headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(body, { headers });
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    const headers = deps.cache.headersFor("error");
    return new Response(JSON.stringify({ error: "internal_error", message: "Internal error." }), {
      status: 500,
      headers,
    });
  }
}
