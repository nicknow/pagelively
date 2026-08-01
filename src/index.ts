/**
 * pagelively Worker — public entry pipeline (S12).
 *
 * Wires the previously built pure pieces (router, redirects, home resolution,
 * D1 repository, R2 object store, cache headers, base injection) into the
 * top-level `fetch` handler. The whole dispatch is wrapped in a single
 * `try/catch` that converts unexpected failures to generic 500s and maps
 * `AppError` through `toErrorResponse`.
 *
 * Admin/API routes are recognized but only return a placeholder 404 for now;
 * their real handlers arrive in S15–S19.
 */

import { AppError, toErrorResponse } from "./errors";
import { classifyPath } from "./router";
import { clean404Response, trailingSlashRedirect } from "./redirects";
import { resolveHome } from "./home";
import { createConfig } from "./config";
import { createCacheService } from "./cache-service";
import { createPagesRepository } from "./pages-repository";
import { createObjectStore } from "./object-store";
import { serveEntry } from "./entry-serve";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Reserved for S13/S16/S17 cache-purge, Access, and upload handlers.
    void ctx;

    const cache = createCacheService(env);

    try {
      const config = createConfig(env);
      const pages = createPagesRepository(env.DB);
      const objects = createObjectStore(env.BUCKET);
      const deps = { config, pages, objects, cache };

      const url = new URL(request.url);
      const method = request.method;
      const route = classifyPath(url.pathname);

      if (route.type === "health") {
        const headers = cache.headersFor("admin");
        return Response.json({ ok: true, service: "pagelively" }, { headers });
      }

      const redirect = trailingSlashRedirect(route, url, method);
      if (redirect) {
        return redirect;
      }

      if (route.type === "home") {
        const home = resolveHome(config.homeMode, config.homePageSlug);
        if (home.type === "404") {
          return clean404Response(url);
        }
        return await serveEntry(new Request(new URL(`/${home.slug}/`, url)), deps);
      }

      if (route.type === "slug" || route.type === "id") {
        return await serveEntry(request, deps);
      }

      if (route.type === "admin" || route.type === "api") {
        const headers = cache.headersFor("admin");
        return Response.json({ error: "not implemented" }, { status: 404, headers });
      }

      return clean404Response(url);
    } catch (error) {
      const headers = cache.headersFor("error");
      if (error instanceof AppError) {
        return toErrorResponse(error, headers);
      }
      return Response.json({ error: "internal_error" }, { status: 500, headers });
    }
  },
} satisfies ExportedHandler<Env>;
