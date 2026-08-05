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
import { serveUnlock } from "./unlock";
import { serveAsset } from "./asset-serve";
import { createUnlocksRepository } from "./unlocks-repository";
import { createAccessVerifier } from "./access-verify";
import { createJwksProvider } from "./jwks-provider";
import { createSettingsRepository } from "./settings-repository";
import {
  handleListPages,
  handleGetPage,
  handleCreatePage,
  handlePatchPage,
  handleAddFiles,
  handleDeleteFile,
  handleDeletePage,
  handleGetSettings,
  handlePatchSettings,
} from "./admin-api";
import {
  handleAdminDashboard,
  handleAdminUpload,
  handleAdminEdit,
  handleAdminSettings,
} from "./admin-ui";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const cache = createCacheService(env);

    try {
      const config = createConfig(env);
      const pages = createPagesRepository(env.DB);
      const filesRepository = createFilesRepository(env.DB);
      const objects = createObjectStore(env.BUCKET);
      const unlocks = createUnlocksRepository(env.DB);
      const jwksProvider = createJwksProvider({
        teamDomainUrl: config.access.teamDomainUrl,
        kv: env.KV,
      });
      const accessVerifier = createAccessVerifier({
        teamDomainUrl: config.access.teamDomainUrl,
        aud: config.access.aud,
        jwksProvider,
      });
      const settingsRepository = createSettingsRepository(env.DB);
      const deps = {
        config,
        pages,
        pagesRepository: pages,
        objects,
        cache,
        accessVerifier,
        filesRepository,
        unlocks,
        settingsRepository,
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
        // Check if a default_page is set in D1 settings (overrides env vars).
        const defaultPageSetting = await settingsRepository.get("default_page");
        if (defaultPageSetting && defaultPageSetting !== "") {
          const target = new URL(`/${defaultPageSetting}/`, url);
          return await serveEntry(new Request(target, { headers: request.headers }), deps);
        }
        const home = resolveHome(config.homeMode, config.homePageSlug);
        if (home.type === "404") {
          return clean404Response(url);
        }
        // S23-C: forward the original request headers so a home-mode protected
        // page can see the pl_unlock cookie (the new request below would
        // otherwise drop it).
        const target = new URL(`/${home.slug}/`, url);
        return await serveEntry(new Request(target, { headers: request.headers }), deps);
      }

      if (route.type === "slug" || route.type === "id") {
        return await serveEntry(request, deps);
      }

      // S23 public surface (ADR 0041 decision 6): unlock and asset routes are
      // dispatched BEFORE the Access gate — they must never require an admin
      // JWT. They are also exempt from the trailing-slash 301 (S08 only touches
      // slug/id routes), so the 303 Location and asset paths are canonical.
      if (route.type === "unlock") {
        return await serveUnlock(request, deps);
      }

      if (route.type === "asset") {
        return await serveAsset(request, deps);
      }

      if (route.type === "admin" || route.type === "api") {
        const identity = await accessVerifier.verify(request);
        if (identity === null) {
          return toErrorResponse(
            new AppError("Forbidden", 403, "Forbidden"),
            cache.headersFor("admin"),
          );
        }

        const adminDeps = {
          ...deps,
          objectStore: objects,
          cacheService: cache,
          verifiedIdentity: identity,
        };

        if (route.type === "admin") {
          const adminPath = url.pathname.replace(/\/+$/, "");
          if (adminPath === "/admin" || adminPath === "/admin/") {
            return await handleAdminDashboard(request, ctx, adminDeps);
          }
          if (adminPath === "/admin/upload") {
            return await handleAdminUpload(request, ctx, adminDeps);
          }
          if (adminPath === "/admin/settings") {
            return await handleAdminSettings(request, ctx, adminDeps);
          }
          if (adminPath.startsWith("/admin/edit/")) {
            return await handleAdminEdit(request, ctx, adminDeps);
          }
          // Unknown admin path: clean 404 with no-store.
          return clean404Response(url);
        }

        // API dispatch.
        const pathname = url.pathname;
        if (pathname === "/api/pages" && method === "GET") {
          return await handleListPages(request, ctx, adminDeps);
        }
        if (pathname === "/api/pages" && method === "POST") {
          return await handleCreatePage(request, ctx, adminDeps);
        }
        const detailMatch = pathname.match(/^\/api\/pages\/([^/]+)\/?$/);
        if (detailMatch && method === "GET") {
          return await handleGetPage(request, ctx, adminDeps);
        }
        if (detailMatch && method === "PATCH") {
          return await handlePatchPage(request, ctx, adminDeps);
        }
        if (detailMatch && method === "DELETE") {
          return await handleDeletePage(request, ctx, adminDeps);
        }
        const filesMatch = pathname.match(/^\/api\/pages\/([^/]+)\/files\/?$/);
        if (filesMatch && method === "POST") {
          return await handleAddFiles(request, ctx, adminDeps);
        }
        const fileDeleteMatch = pathname.match(/^\/api\/pages\/([^/]+)\/files\/(.+)$/);
        if (fileDeleteMatch && method === "DELETE") {
          return await handleDeleteFile(request, ctx, adminDeps);
        }
        if (pathname === "/api/settings" && method === "GET") {
          return await handleGetSettings(request, ctx, adminDeps);
        }
        if (pathname === "/api/settings" && method === "PATCH") {
          return await handlePatchSettings(request, ctx, adminDeps);
        }
        if (pathname === "/api/pages") {
          return toErrorResponse(
            new AppError("method_not_allowed", 405, "Method Not Allowed"),
            cache.headersFor("admin"),
          );
        }
        if (pathname === "/api/settings") {
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
      return Response.json(
        { error: "internal_error", message: "Internal error." },
        { status: 500, headers },
      );
    }
  },
} satisfies ExportedHandler<Env>;
