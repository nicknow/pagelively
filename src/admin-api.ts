/**
 * S15/S17/S18 — Admin API handlers: list, detail, publish, edit, and delete.
 *
 * Exposes `handleListPages` (GET /api/pages), `handleGetPage` (GET
 * /api/pages/:id), `handleCreatePage` (POST /api/pages), `handlePatchPage`
 * (PATCH /api/pages/:id), `handleAddFiles` (POST /api/pages/:id/files),
 * `handleDeleteFile` (DELETE /api/pages/:id/files/:path), and `handleDeletePage`
 * (DELETE /api/pages/:id). All return JSON with
 * `Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`
 * (spec §5/§11). The list response contains only page metadata; the detail,
 * create, edit, and file responses include the page's files.
 *
 * Errors are routed through `toErrorResponse` so the JSON shape stays consistent
 * with the rest of the app (ADR 0005). Invalid ids are rejected before any D1
 * lookup; unknown ids return 404.
 */

import { AppError } from "./errors";
import { validateId, generateId } from "./ids";
import { cleanSlug, slugify, validateSlug } from "./slug";
import { renderMarkdown } from "./markdown";
import { mimeTypeFor, isImageContentType, CHARSET_HTML } from "./content-type";
import { buildR2Key, nextRev } from "./rev";
import {
  parsePublishForm,
  parsePublishJson,
  parseFileUpdateForm,
  type ParsedPublishForm,
} from "./form-parser";
import type { PagesRepository, NewPage, PageRecord } from "./pages-repository";
import type { FilesRepository, NewFile } from "./files-repository";
import type { CacheService } from "./cache-service";
import type { AppConfig } from "./config";
import type { VerifiedIdentity } from "./access-verify";
import type { ObjectStore } from "./object-store";

import type { SettingsRepository } from "./settings-repository";

export interface AdminApiDeps {
  pagesRepository: PagesRepository;
  filesRepository: FilesRepository;
  objectStore: ObjectStore;
  cacheService: CacheService;
  config: AppConfig;
  verifiedIdentity: VerifiedIdentity;
  unlocks: UnlocksRepository;
  settingsRepository?: SettingsRepository;
}

import type { UnlocksRepository } from "./unlocks-repository";
import { hashPassword, validatePassword } from "./password";

/**
 * S23 (ADR 0041 D11): serializer that strips password_hash and emits
 * has_password: boolean. Every page JSON surface uses this so the hash
 * never leaks (R19).
 */
export function toPageJson(record: PageRecord): Record<string, unknown> {
  const { password_hash, ...rest } = record;
  return { ...rest, has_password: password_hash !== null };
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
): { slug?: string } {
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
  // A user-supplied slug is cleaned first (OQ-15/T1, ADR 0036): surrounding
  // whitespace and case are normalized, then the cleaned value is validated.
  // Empty/whitespace-only input is treated as "not provided" (the title is
  // slugified instead). The cleaned slug is returned so it is stored and
  // echoed back in the 201 response.
  let cleanedSlug: string | undefined;
  if (manifest.slug !== undefined) {
    const trimmed = manifest.slug.trim();
    if (trimmed !== "") {
      const result = cleanSlug(trimmed);
      if (!result.ok) {
        throw result.error;
      }
      cleanedSlug = result.slug;
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
  return cleanedSlug === undefined ? {} : { slug: cleanedSlug };
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
  return Response.json(pages.map(toPageJson), { headers });
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
  return Response.json({ ...toPageJson(page), files }, { headers });
}

export async function handleCreatePage(
  request: Request,
  ctx: ExecutionContext,
  deps: AdminApiDeps,
): Promise<Response> {
  const { pagesRepository, filesRepository, objectStore, cacheService, config } = deps;

  const contentType = request.headers.get("content-type") ?? "";
  const { manifest, files } = contentType.startsWith("application/json")
    ? await parsePublishJson(request)
    : await parsePublishForm(request);
  if (files.length === 0) {
    throw new AppError("no_files", 400, "No files were uploaded.");
  }

  const { kind, entry } = determineKindAndEntry(files, manifest.entry);
  const { slug: cleanedSlug } = validateManifest(manifest, files);

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

  const slug = await resolveSlug(cleanedSlug, title, pagesRepository, id);
  const showSource = manifest.showSource === true ? 1 : 0;

  // S23: password validation before any side effects
  let passwordHash: string | undefined;
  if (manifest.password !== undefined) {
    const validation = validatePassword(manifest.password);
    if (validation.status === "invalid") {
      throw new AppError("invalid_password", 400, validation.message);
    }
    if (validation.status === "valid") {
      passwordHash = await hashPassword(validation.value);
    }
    // "not-set" → leave as undefined (no password)
  }

  const r2Files = buildR2Files(files, kind, entry, config.allowRawHtmlInMd, showSource === 1);

  const fileRecords: NewFile[] = r2Files.map((file) => ({
    path: file.path,
    r2_key: buildR2Key(id, rev, file.path),
    content_type: file.contentType,
    size: file.size,
  }));

  // A bundle whose entry is Markdown is rendered and stored as index.html by
  // buildR2Files, just like the top-level "markdown" kind — entry_path must
  // point there too, not at the original upload path (never written to R2
  // under that name), or the entry object lookup at serve time 404s.
  const rawMdPath: string | null =
    kind === "markdown" || (kind === "bundle" && isMarkdownPath(entry)) ? "source.md" : null;
  const entryPath =
    kind === "html" || kind === "markdown" || (kind === "bundle" && isMarkdownPath(entry))
      ? "index.html"
      : entry;

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
    passwordHash,
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

  let createdPage: PageRecord;
  try {
    createdPage = await pagesRepository.create(newPage);
    await filesRepository.replaceAll(id, rev, fileRecords);
  } catch (error) {
    await objectStore.deletePageObjects(id);
    await pagesRepository.delete(id).catch(() => {});
    throw error;
  }

  await cacheService.purgePage(ctx, id);

  const headers = adminJsonHeaders(cacheService);
  return Response.json(
    { ...toPageJson(createdPage), files: fileRecords },
    { status: 201, headers },
  );
}

function isEntryReplacement(page: PageRecord, path: string): boolean {
  if (page.kind === "image") {
    return path === page.entry_path;
  }
  if (page.kind === "markdown") {
    return isMarkdownPath(path);
  }
  // html or bundle
  return path === page.entry_path;
}

/**
 * Returns the served entry path for the page: the stored path that the page
 * router serves as the entry point (the image filename for image pages, the
 * rendered `index.html` for markdown/bundle-with-md pages, or the original HTML
 * path for html/bundle-with-html pages).
 */
function servedEntryPath(page: PageRecord): string {
  if (page.kind === "image") {
    return page.entry_path;
  }
  if (page.kind === "markdown" || (page.kind === "bundle" && page.raw_md_path !== null)) {
    return "index.html";
  }
  return page.entry_path;
}

const PROTECTED_ENTRY_DELETION_MESSAGE =
  "The rendered page files (index.html and source.md) are part of the page and cannot be deleted individually. Delete the page to remove it.";

function protectedEntryDeletionMessage(_page: PageRecord, path: string): string {
  if (path === "index.html" || path === "source.md") {
    return PROTECTED_ENTRY_DELETION_MESSAGE;
  }
  return `The file "${path}" is the page and cannot be deleted individually. Delete the page to remove it.`;
}

/**
 * True when `path` is the served entry or the raw markdown source that renders
 * into it. Such paths cannot be deleted without breaking the page.
 */
export function isProtectedEntryPath(page: PageRecord, path: string): boolean {
  if (path === servedEntryPath(page)) {
    return true;
  }
  if (page.raw_md_path !== null && path === page.raw_md_path) {
    return true;
  }
  return false;
}

function prepareEntryFiles(
  page: PageRecord,
  file: ParsedPublishForm["files"][number],
  allowRawHtml: boolean,
  showSource: boolean,
): Array<{ path: string; content: ArrayBuffer; contentType: string; size: number }> {
  if (
    (page.kind === "markdown" || (page.kind === "bundle" && isMarkdownPath(page.entry_path))) &&
    isMarkdownPath(file.path)
  ) {
    const md = textFromBuffer(file.content);
    const html = renderMarkdown(md, { allowRawHtml, showSource });
    const htmlBytes = bufferFromText(html);
    return [
      {
        path: "source.md",
        content: file.content,
        contentType: mimeTypeFor("source.md"),
        size: file.size,
      },
      {
        path: "index.html",
        content: htmlBytes,
        contentType: CHARSET_HTML,
        size: htmlBytes.byteLength,
      },
    ];
  }
  const storedPath = page.kind === "html" ? "index.html" : file.path;
  return [
    { path: storedPath, content: file.content, contentType: file.contentType, size: file.size },
  ];
}

async function readObjectBody(body: ReadableStream): Promise<ArrayBuffer> {
  return new Response(body).arrayBuffer();
}

function extractIdAndFilePath(pathname: string): { id: string; path: string } | undefined {
  const match = pathname.match(/^\/api\/pages\/([^/]+)\/files\/(.+)$/);
  if (!match) return undefined;
  return { id: match[1], path: decodeURIComponent(match[2]) };
}

function validatePatchBody(body: Record<string, unknown>): {
  slug?: string | null;
  title?: string;
  visibility?: "public" | "unlisted";
  show_source?: 0 | 1;
  password?: string | null;
} {
  const patch: {
    slug?: string | null;
    title?: string;
    visibility?: "public" | "unlisted";
    show_source?: 0 | 1;
    password?: string | null;
  } = {};

  if ("slug" in body) {
    if (typeof body.slug !== "string" && body.slug !== null) {
      throw new AppError("invalid_slug", 400, "Slug must be a string or null.");
    }
    patch.slug = body.slug;
  }
  if ("title" in body) {
    if (typeof body.title !== "string") {
      throw new AppError("invalid_title", 400, "Title must be a string.");
    }
    if (body.title.length > MAX_TITLE_LENGTH) {
      throw new AppError(
        "title_too_long",
        400,
        `Title must be at most ${MAX_TITLE_LENGTH} characters.`,
      );
    }
    patch.title = body.title;
  }
  if ("visibility" in body) {
    if (body.visibility !== "public" && body.visibility !== "unlisted") {
      throw new AppError("invalid_visibility", 400, "Visibility must be 'public' or 'unlisted'.");
    }
    patch.visibility = body.visibility as "public" | "unlisted";
  }
  if ("showSource" in body) {
    if (typeof body.showSource !== "boolean") {
      throw new AppError("invalid_show_source", 400, "showSource must be a boolean.");
    }
    patch.show_source = body.showSource ? 1 : 0;
  }
  if ("password" in body) {
    if (body.password !== null && typeof body.password !== "string") {
      throw new AppError("invalid_password", 400, "Password must be a string.");
    }
    patch.password = body.password as string | null;
  }

  return patch;
}

async function writeFilesAndUpdatePage(
  ctx: ExecutionContext,
  deps: AdminApiDeps,
  page: PageRecord,
  files: Array<{ path: string; content: ArrayBuffer; contentType: string; size: number }>,
  newEntryPath: string,
  newRawMdPath: string | null,
  oldFileRecords: NewFile[] = [],
): Promise<Response> {
  const { pagesRepository, filesRepository, objectStore, cacheService } = deps;
  const newRev = nextRev(page.rev);
  const fileRecords: NewFile[] = files.map((file) => ({
    path: file.path,
    r2_key: buildR2Key(page.id, newRev, file.path),
    content_type: file.contentType,
    size: file.size,
  }));

  for (const file of files) {
    await objectStore.put(page.id, newRev, file.path, file.content, file.contentType);
  }

  let updatedPage: PageRecord;
  let revBumpSucceeded = false;
  try {
    const result = await pagesRepository.applyRevBump(page.id, newRev, newEntryPath, newRawMdPath);
    if (!result) {
      throw new AppError("not_found", 404, "Page not found.");
    }
    updatedPage = result;
    revBumpSucceeded = true;
    await filesRepository.replaceAll(page.id, newRev, fileRecords);
  } catch (error) {
    await objectStore.deletePageRevObjects(page.id, newRev).catch(() => {});
    // If the rev bump succeeded but the file-row replacement failed, restore the
    // previous D1 state so the page remains consistent with the old rev folder.
    if (revBumpSucceeded) {
      await pagesRepository
        .applyRevBump(page.id, page.rev, page.entry_path, page.raw_md_path)
        .catch(() => {});
      await filesRepository.replaceAll(page.id, page.rev, oldFileRecords).catch(() => {});
    }
    throw error;
  }

  await cacheService.purgePage(ctx, page.id);
  const finalFiles = await filesRepository.listForPage(page.id);
  const headers = adminJsonHeaders(cacheService);
  return Response.json({ ...toPageJson(updatedPage), files: finalFiles }, { headers });
}

export async function handlePatchPage(
  request: Request,
  ctx: ExecutionContext,
  deps: AdminApiDeps,
): Promise<Response> {
  const { pagesRepository, filesRepository, objectStore, cacheService, config } = deps;

  const url = new URL(request.url);
  const id = extractIdFromPath(url.pathname);
  if (!id || !validateId(id)) {
    throw new AppError("invalid_id", 400, "Invalid page id.");
  }

  const page = await pagesRepository.getById(id);
  if (!page) {
    throw new AppError("not_found", 404, "Page not found.");
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    throw new AppError("invalid_json", 400, "Request body must be valid JSON.");
  }
  const patch = validatePatchBody(body);

  if (typeof patch.slug === "string" && patch.slug !== page.slug) {
    // Clean the user-entered slug first (OQ-15/T1, ADR 0036): trim, normalize,
    // and reject reserved/empty results with an actionable message. The cleaned
    // value is what gets stored and echoed in the 200 response.
    const cleaned = cleanSlug(patch.slug);
    if (!cleaned.ok) {
      throw cleaned.error;
    }
    if (cleaned.slug !== page.slug) {
      const validation = validateSlug(cleaned.slug);
      /* istanbul ignore next -- reason: cleanSlug returned ok=true => validateSlug already passed (slug.ts:162) */
      if (!validation.ok) {
        throw validation.error;
      }
      const taken = await pagesRepository.slugTaken(cleaned.slug, id);
      if (taken) {
        throw new AppError("slug_conflict", 409, `Slug "${cleaned.slug}" is already taken.`);
      }
    }
    patch.slug = cleaned.slug;
  }

  const newShowSource = patch.show_source ?? page.show_source;
  const needsReRender =
    patch.show_source !== undefined &&
    patch.show_source !== page.show_source &&
    page.raw_md_path !== null;
  let oldEntryHtml: string | null = null;

  if (needsReRender) {
    const rawMdPath = page.raw_md_path;
    /* istanbul ignore next -- reason: guarded by needsReRender (page.raw_md_path !== null) */
    if (rawMdPath === null) {
      throw new AppError("entry_not_found", 404, "Source file not found.");
    }
    const sourceObj = await objectStore.get(page.id, page.rev, rawMdPath);
    if (!sourceObj) {
      throw new AppError("entry_not_found", 404, "Source file not found.");
    }
    const oldEntryObj = await objectStore.get(page.id, page.rev, page.entry_path);
    if (oldEntryObj) {
      oldEntryHtml = await new Response(oldEntryObj.body).text();
    }
    const md = await new Response(sourceObj.body).text();
    const html = renderMarkdown(md, {
      allowRawHtml: config.allowRawHtmlInMd,
      showSource: newShowSource === 1,
    });
    await objectStore.put(page.id, page.rev, page.entry_path, bufferFromText(html), CHARSET_HTML);
  }

  // S23: password handling — tri-state: present (set/clear), absent (unchanged)
  const passwordPresent = "password" in patch;
  let updatedPage: PageRecord | null = null;
  if (passwordPresent) {
    let pwdHash: string | null = null;
    const pwd = patch.password;
    if (pwd !== null && pwd !== "") {
      // set: validate, hash, then store
      const validation = validatePassword(pwd);
      if (validation.status === "invalid") {
        throw new AppError("invalid_password", 400, validation.message);
      }
      if (validation.status === "valid") {
        pwdHash = await hashPassword(validation.value);
      }
      // validation.status === "not-set" (whitespace-only): pwdHash stays null = clear
    }
    // pwdHash === null means clear (whether explicit or whitespace-triggered)
    const result = await pagesRepository.setPasswordHash(id, pwdHash);
    if (!result) throw new AppError("not_found", 404, "Page not found.");
    updatedPage = result;
    await deps.unlocks.deleteByPageId(id);
    await cacheService.purgePage(ctx, id);
    // Remove password from the meta patch so updateMeta doesn't double-write
    delete (patch as Record<string, unknown>).password;
  }

  if (Object.keys(patch).length > 0) {
    try {
      const result = await pagesRepository.updateMeta(id, patch);
      if (!result) throw new AppError("not_found", 404, "Page not found.");
      updatedPage = result;
      await cacheService.purgePage(ctx, id);
    } catch (error) {
      if (needsReRender && oldEntryHtml !== null) {
        await objectStore
          .put(page.id, page.rev, page.entry_path, bufferFromText(oldEntryHtml), CHARSET_HTML)
          .catch(() => {});
      }
      throw error;
    }
  }

  if (!updatedPage) {
    // No changes at all (empty patch); re-fetch
    const result = await pagesRepository.getById(id);
    if (!result) throw new AppError("not_found", 404, "Page not found.");
    updatedPage = result;
  }

  const files = await filesRepository.listForPage(id);
  const headers = adminJsonHeaders(cacheService);
  return Response.json({ ...toPageJson(updatedPage), files }, { headers });
}

export async function handleAddFiles(
  request: Request,
  ctx: ExecutionContext,
  deps: AdminApiDeps,
): Promise<Response> {
  const { pagesRepository, filesRepository, objectStore, config } = deps;

  const url = new URL(request.url);
  const idMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/files\/?$/);
  const id = idMatch ? idMatch[1] : undefined;
  if (!id || !validateId(id)) {
    throw new AppError("invalid_id", 400, "Invalid page id.");
  }

  const page = await pagesRepository.getById(id);
  if (!page) {
    throw new AppError("not_found", 404, "Page not found.");
  }

  const uploadedFiles = await parseFileUpdateForm(request);
  if (uploadedFiles.length === 0) {
    throw new AppError("no_files", 400, "No files were uploaded.");
  }

  const existingFiles = await filesRepository.listForPage(id);
  const oldFileRecords: NewFile[] = existingFiles.map((file) => ({
    path: file.path,
    r2_key: file.r2_key,
    content_type: file.content_type,
    size: file.size,
  }));
  const finalFiles = new Map<string, { content: ArrayBuffer; contentType: string; size: number }>();
  const providedPaths = new Set<string>();

  for (const file of uploadedFiles) {
    if (isEntryReplacement(page, file.path)) {
      const entries = prepareEntryFiles(
        page,
        file,
        config.allowRawHtmlInMd,
        page.show_source === 1,
      );
      for (const entry of entries) {
        finalFiles.set(entry.path, entry);
        providedPaths.add(entry.path);
      }
    } else {
      finalFiles.set(file.path, {
        content: file.content,
        contentType: file.contentType,
        size: file.size,
      });
      providedPaths.add(file.path);
    }
  }

  for (const fileRecord of existingFiles) {
    if (!providedPaths.has(fileRecord.path)) {
      const stored = await objectStore.get(page.id, page.rev, fileRecord.path);
      if (!stored) continue;
      const content = await readObjectBody(stored.body);
      finalFiles.set(fileRecord.path, {
        content,
        contentType: fileRecord.content_type,
        size: fileRecord.size,
      });
    }
  }

  const files = Array.from(finalFiles.entries()).map(([path, file]) => ({
    path,
    ...file,
  }));

  return await writeFilesAndUpdatePage(
    ctx,
    deps,
    page,
    files,
    page.entry_path,
    page.raw_md_path,
    oldFileRecords,
  );
}

export async function handleDeleteFile(
  request: Request,
  ctx: ExecutionContext,
  deps: AdminApiDeps,
): Promise<Response> {
  const { pagesRepository, filesRepository, objectStore } = deps;

  const url = new URL(request.url);
  const match = extractIdAndFilePath(url.pathname);
  if (!match || !validateId(match.id)) {
    throw new AppError("invalid_id", 400, "Invalid page id.");
  }

  const page = await pagesRepository.getById(match.id);
  if (!page) {
    throw new AppError("not_found", 404, "Page not found.");
  }

  if (isProtectedEntryPath(page, match.path)) {
    throw new AppError("entry_not_deletable", 400, protectedEntryDeletionMessage(page, match.path));
  }

  const existingFiles = await filesRepository.listForPage(page.id);
  const oldFileRecords: NewFile[] = existingFiles.map((file) => ({
    path: file.path,
    r2_key: file.r2_key,
    content_type: file.content_type,
    size: file.size,
  }));
  const targetFile = existingFiles.find((f) => f.path === match.path);
  if (!targetFile) {
    throw new AppError("not_found", 404, "File not found.");
  }

  const remainingFiles: Array<{
    path: string;
    content: ArrayBuffer;
    contentType: string;
    size: number;
  }> = [];
  for (const fileRecord of existingFiles) {
    if (fileRecord.path === match.path) continue;
    const stored = await objectStore.get(page.id, page.rev, fileRecord.path);
    if (!stored) continue;
    const content = await readObjectBody(stored.body);
    remainingFiles.push({
      path: fileRecord.path,
      content,
      contentType: fileRecord.content_type,
      size: fileRecord.size,
    });
  }

  return await writeFilesAndUpdatePage(
    ctx,
    deps,
    page,
    remainingFiles,
    page.entry_path,
    page.raw_md_path,
    oldFileRecords,
  );
}

export async function handleDeletePage(
  request: Request,
  ctx: ExecutionContext,
  deps: AdminApiDeps,
): Promise<Response> {
  const { pagesRepository, objectStore, cacheService } = deps;

  const url = new URL(request.url);
  const id = extractIdFromPath(url.pathname);
  if (!id || !validateId(id)) {
    throw new AppError("invalid_id", 400, "Invalid page id.");
  }

  const page = await pagesRepository.getById(id);
  if (!page) {
    throw new AppError("not_found", 404, "Page not found.");
  }

  await pagesRepository.delete(id);
  await objectStore.deletePageObjects(id);
  await cacheService.purgePage(ctx, id);

  return new Response(null, { status: 204, headers: adminJsonHeaders(cacheService) });
}

export async function handleGetSettings(
  _request: Request,
  _ctx: ExecutionContext,
  deps: AdminApiDeps,
): Promise<Response> {
  const { cacheService, settingsRepository } = deps;
  const settings = await settingsRepository!.getAll();
  const headers = adminJsonHeaders(cacheService);
  return Response.json(settings, { headers });
}

export async function handlePatchSettings(
  request: Request,
  _ctx: ExecutionContext,
  deps: AdminApiDeps,
): Promise<Response> {
  const { cacheService, settingsRepository } = deps;

  let body: Record<string, string | null>;
  try {
    body = (await request.json()) as Record<string, string | null>;
  } catch {
    throw new AppError("invalid_json", 400, "Request body must be valid JSON.");
  }

  const repo = settingsRepository!;
  for (const [key, value] of Object.entries(body)) {
    if (value === null) {
      // null = delete the setting (restore default)
      await repo.set(key, "");
    } else if (typeof value === "string") {
      await repo.set(key, value);
    } else {
      throw new AppError("invalid_setting", 400, `Invalid value for setting "${key}".`);
    }
  }

  const settings = await repo.getAll();
  const headers = adminJsonHeaders(cacheService);
  return Response.json(settings, { headers });
}
