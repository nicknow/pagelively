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
 * - S24-C: raw-markdown pages follow the same pattern — a public entry 301s
 *   to the CDN `source.md` object; an unlocked protected entry is served as
 *   Worker bytes with its stored `text/plain` content type, never a 301
 *   (ADR 0041 decision 6).
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
import { escapeHtml } from "./utils";

export interface EntryServeDependencies {
  config: AppConfig;
  pages: Pick<PagesRepository, "getById" | "getBySlug" | "list">;
  /** S23-C: the unlock-row seam for the public password gate (ADR 0041 decision 3). */
  unlocks: Pick<UnlocksRepository, "getByPageId">;
  objects: Pick<ObjectStore, "get">;
  cache: CacheService;
  tagsRepository?: import("./tags-repository").TagsRepository;
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
 * Render a listing page: an HTML document showing linked pages matching the
 * configured tags.
 */
function renderListingPage(
  page: { id: string; title: string; slug: string | null; match_tags: string | null },
  matchingPages: Array<{ id: string; title: string; slug: string | null; created_at: string }>,
  config: AppConfig,
): string {
  const rows = matchingPages
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((p) => {
      const url = p.slug ? `/${p.slug}/` : `/p/${p.id}/`;
      return `<li><a href="${escapeHtml(url)}">${escapeHtml(p.title ?? "Untitled")}</a></li>`;
    })
    .join("\n");

  const siteName = escapeHtml(config.siteName);
  const title = escapeHtml(page.title);
  const matchedTags = page.match_tags
    ? page.match_tags
        .split(",")
        .map((t) => `<span class="tag">${escapeHtml(t.trim())}</span>`)
        .join(" ")
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — ${siteName}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 800px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .tags { margin-bottom: 1.5rem; }
    .tag { display: inline-block; background: #e2e8f0; padding: 0.125rem 0.5rem; border-radius: 999px; font-size: 0.75rem; }
    ul { list-style: none; padding: 0; }
    li { padding: 0.5rem 0; border-bottom: 1px solid #e2e8f0; }
    li:last-child { border-bottom: none; }
    a { color: #2563eb; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .empty { color: #64748b; font-style: italic; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  ${matchedTags ? `<div class="tags">${matchedTags}</div>` : ""}
  ${rows.length > 0 ? `<ul>${rows}</ul>` : '<p class="empty">No matching pages yet.</p>'}
</body>
</html>`;
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

    // Image and raw-markdown pages (S24-C) are pure object surfaces: a public
    // entry is a 301 to the CDN object (spec §6/§11 — the Worker stays out of
    // the hot path; for raw pages the target is the verbatim source.md), and
    // an unlocked protected entry is Worker bytes — a 301 to the CDN would
    // leak the object URL and bypass the gate (ADR 0041 decision 6). The
    // protected branch streams the stored object with its stored content type
    // ("text/plain; charset=utf-8" for raw pages, set at publish time).
    if (page.kind === "image" || page.kind === "raw-markdown") {
      if (page.password_hash !== null) {
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

    // Listing pages: render a dynamic list of pages that have ALL configured tags.
    // Must check BEFORE the R2 entry read — listing pages have no uploaded files.
    if (page.kind === "listing") {
      const matchTags = page.match_tags;
      if (!matchTags || !deps.tagsRepository) {
        const headers = deps.cache.headersFor("entry", page.id);
        headers.set("Content-Type", "text/html; charset=utf-8");
        const emptyListing = renderListingPage(page, [], deps.config);
        return new Response(emptyListing, { headers });
      }
      const matchTagList = matchTags
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      const matchingPageIds = await deps.tagsRepository.findPagesByTags(matchTagList);
      const allPages = await deps.pages.list();
      const matchingPages = allPages.filter(
        (p) => matchingPageIds.includes(p.id) && p.id !== page.id && p.visibility === "public",
      );
      const listingHtml = renderListingPage(page, matchingPages, deps.config);
      const headers = deps.cache.headersFor("entry", page.id);
      headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(listingHtml, { headers });
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
