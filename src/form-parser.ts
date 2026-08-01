/**
 * S17 — Multipart form parser for the publish API.
 *
 * `parsePublishForm(request)` reads a `multipart/form-data` body, validates the
 * `manifest` JSON field, and extracts file parts keyed by `file:<path>`. It is the
 * write-side front line for path security: `%` in filenames and `../` / absolute
 * paths are rejected before they reach the R2 key builder.
 */

export interface ParsedPublishForm {
  manifest: {
    slug?: string;
    title?: string;
    showSource?: boolean;
    entry?: string;
    visibility?: "public" | "unlisted";
  };
  files: Array<{
    path: string;
    name: string;
    content: ArrayBuffer;
    size: number;
    contentType: string;
  }>;
}

import { AppError } from "./errors";
import { mimeTypeFor } from "./content-type";

/** ~95 MB guard before buffering a multipart body (Cloudflare free/pro limit is ~100 MB). */
const MAX_BODY_SIZE = 95 * 1024 * 1024;

const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function stripLeadingBom(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.length >= UTF8_BOM.length &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
  ) {
    return bytes.slice(UTF8_BOM.length).buffer as ArrayBuffer;
  }
  return bytes.buffer as ArrayBuffer;
}

function validateFilePath(path: string, filename: string): void {
  if (path === "") {
    throw new AppError("invalid_path", 400, "File path must not be empty.");
  }
  if (path.startsWith("/")) {
    throw new AppError("path_traversal", 400, `Absolute file paths are not allowed: "${path}".`);
  }
  if (path.includes("../") || path.includes("\\")) {
    throw new AppError("path_traversal", 400, `Path traversal is not allowed: "${path}".`);
  }
  if (path.includes("%") || filename.includes("%")) {
    throw new AppError(
      "invalid_filename",
      400,
      `Percent signs are not allowed in filenames: "${filename}".`,
    );
  }
}

function parseManifestField(raw: string): ParsedPublishForm["manifest"] {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new AppError("invalid_manifest", 400, "Manifest must be a JSON object.");
    }
    const manifest: ParsedPublishForm["manifest"] = {};
    if ("slug" in parsed && typeof parsed.slug === "string") {
      manifest.slug = parsed.slug;
    }
    if ("title" in parsed && typeof parsed.title === "string") {
      manifest.title = parsed.title;
    }
    if ("showSource" in parsed && typeof parsed.showSource === "boolean") {
      manifest.showSource = parsed.showSource;
    }
    if ("entry" in parsed && typeof parsed.entry === "string") {
      manifest.entry = parsed.entry;
    }
    if ("visibility" in parsed && typeof parsed.visibility === "string") {
      manifest.visibility = parsed.visibility as "public" | "unlisted";
    }
    return manifest;
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw new AppError("invalid_manifest", 400, "Manifest is not valid JSON.");
  }
}

export async function parsePublishForm(request: Request): Promise<ParsedPublishForm> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_BODY_SIZE) {
    throw new AppError("request_too_large", 413, "Request body exceeds the ~95 MB upload limit.");
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppError("invalid_form_data", 400, "Could not parse multipart form data.", detail);
  }

  const manifest: ParsedPublishForm["manifest"] = {};
  const files: ParsedPublishForm["files"] = [];

  for (const [name, value] of formData) {
    if (name === "manifest") {
      if (typeof value !== "string") {
        throw new AppError("invalid_manifest", 400, "Manifest field must be a JSON string.");
      }
      Object.assign(manifest, parseManifestField(value));
      continue;
    }

    if (name.startsWith("file:")) {
      const file = await parseFilePart(name, value);
      if (file) {
        files.push(file);
      }
    }
  }

  return { manifest, files };
}

/**
 * Parse a file-only multipart form used by `POST /api/pages/:id/files`.
 * Only `file:<path>` parts are accepted; a manifest field is ignored.
 */
export async function parseFileUpdateForm(request: Request): Promise<ParsedPublishForm["files"]> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_BODY_SIZE) {
    throw new AppError("request_too_large", 413, "Request body exceeds the ~95 MB upload limit.");
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AppError("invalid_form_data", 400, "Could not parse multipart form data.", detail);
  }

  const files: ParsedPublishForm["files"] = [];
  for (const [name, value] of formData) {
    if (name.startsWith("file:")) {
      const file = await parseFilePart(name, value);
      if (file) {
        files.push(file);
      }
    }
  }

  return files;
}

async function parseFilePart(
  name: string,
  value: unknown,
): Promise<ParsedPublishForm["files"][number] | null> {
  const path = name.slice("file:".length);
  if (!(value instanceof File)) {
    throw new AppError("invalid_file", 400, `File field "${name}" is not a file.`);
  }
  const filename = value.name;
  validateFilePath(path, filename);

  const bytes = new Uint8Array(await value.arrayBuffer());
  const content = isMarkdownPath(path) ? stripLeadingBom(bytes) : bytes.buffer;
  return {
    path,
    name: filename,
    content,
    size: content.byteLength,
    contentType: mimeTypeFor(path),
  };
}
