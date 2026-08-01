/**
 * pagelively Worker — public entry pipeline (S12).
 *
 * Wires the previously built pure pieces (router, redirects, home resolution,
 * D1 repository, R2 object store, cache headers, base injection) into the
 * top-level `fetch` handler. The whole dispatch is wrapped in a single
 * `try/catch` that converts unexpected failures to generic 500s and maps
 * `AppError` through `toErrorResponse`.
 *
 * Admin/API routes are protected by the Access JWT verifier (S16). Unverified
 * requests return 403; verified GET /api/pages and /api/pages/:id requests are
 * handled by S15. Other admin/API routes return placeholder responses until
 * S17–S19.
 */

import { AppError, toErrorResponse } from "./errors";
import { classifyPath } from "./router";
import { clean404Response, trailingSlashRedirect } from "./redirects";
import { resolveHome } from "./home";
import { createConfig } from "./config";
import { createCacheService } from "./cache-service";
import { createPagesRepository } from "./pages-repository";
import { createFilesRepository } from "./files-repository";
import { createObjectStore } from "./object-store";
import { serveEntry } from "./entry-serve";
import { createAccessVerifier } from "./access-verify";
import { createJwksProvider } from "./jwks-provider";
import { handleListPages, handleGetPage } from "./admin-api";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cache = createCacheService(env);

    try {
      const config = createConfig(env);
      const pages = createPagesRepository(env.DB);
      const filesRepository = createFilesRepository(env.DB);
      const objects = createObjectStore(env.BUCKET);
      const jwksProvider = createJwksProvider({
        teamDomainUrl: config.access.teamDomainUrl,
        kv: env.KV,
      });
      const accessVerifier = createAccessVerifier({
        teamDomainUrl: config.access.teamDomainUrl,
        aud: config.access.aud,
        jwksProvider,
      });
      const deps = {
        config,
        pages,
        pagesRepository: pages,
        objects,
        cache,
        accessVerifier,
        filesRepository,
      };

      const url = new URL(request.url);
      const method = request.method;
      const route = classifyPath(url.pathname);

      if (route.type === "health") {
        const headers = cache.headersFor("admin");
        headers.set("Content-Type", "application/json; charset=utf-8");
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
        const identity = await accessVerifier.verify(request);
        if (identity === null) {
          return toErrorResponse(
            new AppError("Forbidden", 403, "Forbidden"),
            cache.headersFor("admin"),
          );
        }

        const adminDeps = { ...deps, cacheService: cache, verifiedIdentity: identity };

        if (route.type === "admin") {
          // Placeholder HTML 404 until S19 implements the admin UI.
          const headers = cache.headersFor("admin");
          headers.set("Content-Type", "text/html; charset=utf-8");
          return new Response(
            "<!doctype html><html><head><title>Not Found</title></head><body><h1>Not Found</h1></body></html>",
            { status: 404, headers },
          );
        }

        // API dispatch.
        const pathname = url.pathname;
        if (pathname === "/api/pages" && method === "GET") {
          return await handleListPages(request, ctx, adminDeps);
        }
        const detailMatch = pathname.match(/^\/api\/pages\/([^/]+)\/?$/);
        if (detailMatch && method === "GET") {
          return await handleGetPage(request, ctx, adminDeps);
        }
        if (pathname === "/api/pages") {
          return toErrorResponse(
            new AppError("method_not_allowed", 405, "Method Not Allowed"),
            cache.headersFor("admin"),
          );
        }
        return toErrorResponse(
          new AppError("not_found", 404, "Not Found"),
          cache.headersFor("admin"),
        );
      }

      return clean404Response(url);
    } catch (error) {
      const headers = cache.headersFor("error");
      if (error instanceof AppError) {
        return toErrorResponse(error, headers);
      }
      headers.set("Content-Type", "application/json; charset=utf-8");
      return Response.json({ error: "internal_error" }, { status: 500, headers });
    }
  },
} satisfies ExportedHandler<Env>;
