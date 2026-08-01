/**
 * S15/S17 — Admin API handlers: list, detail, and publish.
 *
 * Exposes `handleListPages` (GET /api/pages), `handleGetPage` (GET
 * /api/pages/:id), and `handleCreatePage` (POST /api/pages). All return JSON with
 * `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`
 * (spec §5/§11). The list response contains only page metadata; the detail and
 * create responses include the page's files.
 *
 * Errors are routed through `toErrorResponse` so the JSON shape stays consistent
 * with the rest of the app (ADR 0005). Invalid ids are rejected before any D1
 * lookup; unknown ids return 404.
 *
 * The `verifiedIdentity` dependency is available to future handlers but is not
 * consumed by these read-only endpoints.
 */

import { AppError } from "./errors";
import { validateId, generateId } from "./ids";
import { slugify, validateSlug } from "./slug";
import { renderMarkdown } from "./markdown";
import { mimeTypeFor, isImageContentType, CHARSET_HTML } from "./content-type";
import { buildR2Key } from "./rev";
import { parsePublishForm, type ParsedPublishForm } from "./form-parser";
import type { PagesRepository, NewPage } from "./pages-repository";
import type { FilesRepository, NewFile } from "./files-repository";
import type { CacheService } from "./cache-service";
import type { AppConfig } from "./config";
import type { VerifiedIdentity } from "./access-verify";
import type { ObjectStore } from "./object-store";

export interface AdminApiDeps {
  pagesRepository: PagesRepository;
  filesRepository: FilesRepository;
  objectStore: ObjectStore;
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

const MAX_TITLE_LENGTH = 256;
const MAX_SLUG_SUFFIX_ATTEMPTS = 1000;

type PageKind = "image" | "html" | "markdown" | "bundle";

function isHtmlPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".html") || lower.endsWith(".htm");
}

function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function isDocumentPath(path: string): boolean {
  return isHtmlPath(path) || isMarkdownPath(path);
}

function stripExtension(name: string): string {
  return name.replace(/\.([a-zA-Z]+)$/, "");
}

function deriveTitle(name: string): string {
  return stripExtension(name.split("/").pop() ?? name);
}

function bufferFromText(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

function textFromBuffer(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
}

function validateManifest(
  manifest: ParsedPublishForm["manifest"],
  files: ParsedPublishForm["files"],
): void {
  if (
    manifest.visibility !== undefined &&
    manifest.visibility !== "public" &&
    manifest.visibility !== "unlisted"
  ) {
    throw new AppError("invalid_visibility", 400, "Visibility must be 'public' or 'unlisted'.");
  }
  if (manifest.title !== undefined && manifest.title.length > MAX_TITLE_LENGTH) {
    throw new AppError(
      "title_too_long",
      400,
      `Title must be at most ${MAX_TITLE_LENGTH} characters.`,
    );
  }
  if (manifest.slug !== undefined && manifest.slug !== "") {
    const result = validateSlug(manifest.slug);
    if (!result.ok) {
      throw result.error;
    }
  }
  if (manifest.entry !== undefined) {
    const entryFile = files.find((f) => f.path === manifest.entry);
    if (!entryFile) {
      throw new AppError(
        "invalid_entry",
        400,
        `Manifest entry "${manifest.entry}" does not match any uploaded file.`,
      );
    }
  }
}

function determineKindAndEntry(
  files: ParsedPublishForm["files"],
  manifestEntry?: string,
): { kind: PageKind; entry: string } {
  const documents = files.filter((f) => isDocumentPath(f.path));
  const images = files.filter((f) => isImageContentType(f.contentType));

  if (documents.length === 1) {
    const doc = documents[0];
    return isHtmlPath(doc.path)
      ? { kind: "html", entry: doc.path }
      : { kind: "markdown", entry: doc.path };
  }

  if (documents.length === 0 && images.length === 1 && files.length === 1) {
    return { kind: "image", entry: images[0].path };
  }

  // bundle: multiple documents, an image with other assets, or no clear candidate
  const candidates = [...documents, ...images];
  if (candidates.length === 1) {
    return { kind: "bundle", entry: candidates[0].path };
  }
  if (manifestEntry === undefined) {
    throw new AppError("ambiguous_entry", 400, "Entry is ambiguous. Provide manifest.entry.");
  }
  return { kind: "bundle", entry: manifestEntry };
}

async function resolveSlug(
  manifestSlug: string | undefined,
  sourceName: string,
  pagesRepository: PagesRepository,
  id: string,
): Promise<string> {
  if (manifestSlug !== undefined && manifestSlug !== "") {
    const taken = await pagesRepository.slugTaken(manifestSlug);
    if (taken) {
      throw new AppError("slug_conflict", 409, `Slug "${manifestSlug}" is already taken.`);
    }
    return manifestSlug;
  }

  const slugifyResult = slugify(sourceName);
  if (!slugifyResult.ok) {
    return id;
  }
  const baseSlug = slugifyResult.slug;
  const validation = validateSlug(baseSlug);
  if (!validation.ok) {
    return id;
  }

  let candidate = baseSlug;
  for (let suffix = 2; suffix <= MAX_SLUG_SUFFIX_ATTEMPTS; suffix++) {
    const taken = await pagesRepository.slugTaken(candidate);
    if (!taken) {
      return candidate;
    }
    candidate = `${baseSlug}-${suffix}`;
  }
  return id;
}

function buildR2Files(
  files: ParsedPublishForm["files"],
  kind: PageKind,
  entry: string,
  allowRawHtml: boolean,
  showSource: boolean,
): Array<{ path: string; content: ArrayBuffer; contentType: string; size: number }> {
  const r2Files: Array<{ path: string; content: ArrayBuffer; contentType: string; size: number }> =
    [];

  for (const file of files) {
    if (kind === "html" && file.path === entry) {
      r2Files.push({
        path: "index.html",
        content: file.content,
        contentType: CHARSET_HTML,
        size: file.size,
      });
    } else if (kind === "markdown" && file.path === entry) {
      const md = textFromBuffer(file.content);
      const html = renderMarkdown(md, { allowRawHtml, showSource });
      const htmlBytes = bufferFromText(html);
      r2Files.push({
        path: "source.md",
        content: file.content,
        contentType: mimeTypeFor("source.md"),
        size: file.size,
      });
      r2Files.push({
        path: "index.html",
        content: htmlBytes,
        contentType: CHARSET_HTML,
        size: htmlBytes.byteLength,
      });
    } else if (kind === "bundle" && file.path === entry && isMarkdownPath(entry)) {
      const md = textFromBuffer(file.content);
      const html = renderMarkdown(md, { allowRawHtml, showSource });
      const htmlBytes = bufferFromText(html);
      r2Files.push({
        path: "source.md",
        content: file.content,
        contentType: mimeTypeFor("source.md"),
        size: file.size,
      });
      r2Files.push({
        path: "index.html",
        content: htmlBytes,
        contentType: CHARSET_HTML,
        size: htmlBytes.byteLength,
      });
    } else {
      r2Files.push({
        path: file.path,
        content: file.content,
        contentType: file.contentType,
        size: file.size,
      });
    }
  }
  return r2Files;
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

export async function handleCreatePage(
  request: Request,
  ctx: ExecutionContext,
  deps: AdminApiDeps,
): Promise<Response> {
  const { pagesRepository, filesRepository, objectStore, cacheService, config } = deps;

  const { manifest, files } = await parsePublishForm(request);
  if (files.length === 0) {
    throw new AppError("no_files", 400, "No files were uploaded.");
  }

  const { kind, entry } = determineKindAndEntry(files, manifest.entry);
  validateManifest(manifest, files);

  const id = generateId();
  const now = new Date().toISOString();
  const rev = 1;

  const title =
    manifest.title && manifest.title !== ""
      ? manifest.title
      : deriveTitle(entry.split("/").pop() ?? entry);
  if (title.length > MAX_TITLE_LENGTH) {
    throw new AppError(
      "title_too_long",
      400,
      `Title must be at most ${MAX_TITLE_LENGTH} characters.`,
    );
  }

  const slug = await resolveSlug(manifest.slug, title, pagesRepository, id);
  const showSource = manifest.showSource === true ? 1 : 0;

  const r2Files = buildR2Files(files, kind, entry, config.allowRawHtmlInMd, showSource === 1);

  const fileRecords: NewFile[] = r2Files.map((file) => ({
    path: file.path,
    r2_key: buildR2Key(id, rev, file.path),
    content_type: file.contentType,
    size: file.size,
  }));

  const rawMdPath: string | null =
    kind === "markdown" || (kind === "bundle" && isMarkdownPath(entry)) ? "source.md" : null;
  const entryPath = kind === "html" || kind === "markdown" ? "index.html" : entry;

  const newPage: NewPage = {
    id,
    slug,
    title,
    kind,
    rev,
    entry_path: entryPath,
    raw_md_path: rawMdPath,
    show_source: showSource,
    visibility: manifest.visibility ?? "public",
    created_at: now,
    updated_at: now,
  };

  try {
    for (const file of r2Files) {
      await objectStore.put(id, rev, file.path, file.content, file.contentType);
    }
  } catch (error) {
    await objectStore.deletePageObjects(id);
    throw error;
  }

  try {
    await pagesRepository.create(newPage);
    await filesRepository.replaceAll(id, rev, fileRecords);
  } catch (error) {
    await objectStore.deletePageObjects(id);
    await pagesRepository.delete(id).catch(() => {});
    throw error;
  }

  await cacheService.purgePage(ctx, id);

  const headers = adminJsonHeaders(cacheService);
  return Response.json({ ...newPage, files: fileRecords }, { status: 201, headers });
}
