/**
 * S12 — Entry serving pipeline (spec §5, §6, §11; architecture 02).
 *
 * Resolves a slug or id to a page row via D1, then:
 * - image pages → 301 redirect to the CDN object.
 * - html / markdown / bundle pages → fetch the entry HTML from R2, inject the
 *   `<base href="{ASSET_BASE_URL}/pages/{id}/{rev}/">` tag, and return it with
 *   entry cache headers.
 *
 * Markdown entries are already rendered to HTML at publish time (S17), so this
 * layer does not need the markdown renderer; the dependency slot is reserved
 * in the interface for the future upload pipeline.
 */

import type { AppConfig } from "./config";
import type { PagesRepository } from "./pages-repository";
import type { ObjectStore } from "./object-store";
import type { CacheService } from "./cache-service";
import { AppError } from "./errors";
import { classifyPath } from "./router";
import { clean404Response } from "./redirects";
import { injectBase } from "./base-inject";

export interface EntryServeDependencies {
  config: AppConfig;
  pages: Pick<PagesRepository, "getById" | "getBySlug">;
  objects: Pick<ObjectStore, "get">;
  cache: CacheService;
  /** Reserved for S17; not used for serving. */
  markdown?: unknown;
}

/** Build the CDN base href for a page. */
function buildBaseHref(config: AppConfig, pageId: string, rev: number): string {
  return `${config.assetBaseUrl}/pages/${pageId}/${rev}/`;
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

    const baseHref = buildBaseHref(deps.config, page.id, page.rev);

    if (page.kind === "image") {
      const headers = deps.cache.headersFor("redirect", page.id);
      headers.set("Location", `${baseHref}${page.entry_path}`);
      return new Response(null, { status: 301, headers });
    }

    const stored = await deps.objects.get(page.id, page.rev, page.entry_path);
    if (!stored) {
      return clean404Response(url);
    }

    const html = await new Response(stored.body).text();
    const body = injectBase(html, baseHref);
    const headers = deps.cache.headersFor("entry", page.id);
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
