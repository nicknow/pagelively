/**
 * S15 — Admin API handlers: list & detail.
 *
 * Exposes `handleListPages` (GET /api/pages) and `handleGetPage` (GET
 * /api/pages/:id). Both return JSON with `Content-Type: application/json;
 * charset=utf-8` and `Cache-Control: no-store` (spec §5/§11). The list response
 * contains only page metadata; the detail response includes the page's files.
 *
 * Errors are routed through `toErrorResponse` so the JSON shape stays consistent
 * with the rest of the app (ADR 0005). Invalid ids are rejected before any D1
 * lookup; unknown ids return 404.
 *
 * The `verifiedIdentity` dependency is available to future handlers but is not
 * consumed by these read-only endpoints.
 */

import { AppError } from "./errors";
import { validateId } from "./ids";
import type { PagesRepository } from "./pages-repository";
import type { FilesRepository } from "./files-repository";
import type { CacheService } from "./cache-service";
import type { AppConfig } from "./config";
import type { VerifiedIdentity } from "./access-verify";

export interface AdminApiDeps {
  pagesRepository: PagesRepository;
  filesRepository: FilesRepository;
  cacheService: CacheService;
  config: AppConfig;
  verifiedIdentity: VerifiedIdentity;
}

function adminJsonHeaders(cacheService: CacheService): Headers {
  const headers = cacheService.headersFor("admin");
  headers.set("Content-Type", "application/json; charset=utf-8");
  return headers;
}

function extractIdFromPath(pathname: string): string | undefined {
  const match = pathname.match(/^\/api\/pages\/([^/]+)\/?$/);
  return match ? match[1] : undefined;
}

export async function handleListPages(
  _request: Request,
  _ctx: ExecutionContext,
  deps: AdminApiDeps,
): Promise<Response> {
  const { pagesRepository, cacheService, config, verifiedIdentity } = deps;
  // Read-only endpoints do not consume identity/config yet, but reference them
  // so the unused-parameter lint rule stays happy and the contract is explicit.
  void config;
  void verifiedIdentity;

  const pages = await pagesRepository.list();
  const headers = adminJsonHeaders(cacheService);
  return Response.json(pages, { headers });
}

export async function handleGetPage(
  request: Request,
  _ctx: ExecutionContext,
  deps: AdminApiDeps,
): Promise<Response> {
  const { pagesRepository, filesRepository, cacheService, config, verifiedIdentity } = deps;
  void config;
  void verifiedIdentity;

  const url = new URL(request.url);
  const id = extractIdFromPath(url.pathname);
  if (!id || !validateId(id)) {
    throw new AppError("invalid_id", 400, "Invalid page id.");
  }

  const page = await pagesRepository.getById(id);
  if (!page) {
    throw new AppError("not_found", 404, "Page not found.");
  }

  const files = await filesRepository.listForPage(id);
  const headers = adminJsonHeaders(cacheService);
  return Response.json({ ...page, files }, { headers });
}
