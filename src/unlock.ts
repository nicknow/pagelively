/**
 * S23-C — Public unlock surface (ADR 0041 decisions 1, 3, 6; architecture 02
 * `serveUnlock` contract).
 *
 * GET  /p/{id}/unlock  → the password prompt for a protected page; a clean 404
 *                        for unknown or unprotected pages (no protection-state
 *                        disclosure — a protected page's existence is never
 *                        broadcast, parity with `unlisted`).
 * POST /p/{id}/unlock  → missing/blank/invalid password → 400 `invalid_password`
 *                        JSON; wrong password → 200 prompt with an escaped
 *                        inline error; correct password → upsert a fresh token
 *                        hash, set the `pl_unlock` cookie, 303 to `/p/{id}/`.
 * Other methods        → 405 `method_not_allowed`.
 *
 * The gate predicate `hasValidUnlockCookie` is the same constant-time token
 * check `serveEntry` runs before serving a protected page.
 *
 * All responses use `headersFor("protected")` — no-store, never a Cache-Tag
 * (ADR 0041 decision 9). PBKDF2 runs only on the unlock POST, never on the
 * page-view path.
 */

import { AppError } from "./errors";
import { classifyPath } from "./router";
import { clean404Response } from "./redirects";
import { renderPasswordPrompt } from "./password-prompt";
import { validatePassword, verifyPassword, constantTimeEqual } from "./password";
import { generateToken, hashToken, parseUnlockCookie, formatUnlockCookie } from "./password-token";
import type { AppConfig } from "./config";
import type { PagesRepository } from "./pages-repository";
import type { UnlocksRepository } from "./unlocks-repository";
import type { CacheService } from "./cache-service";

export interface UnlockDependencies {
  config: AppConfig;
  pages: Pick<PagesRepository, "getById">;
  unlocks: Pick<UnlocksRepository, "create" | "getByPageId">;
  cache: CacheService;
}

const COOKIE_NAME = "pl_unlock";
const COOKIE_ATTRS = "Path=/; HttpOnly; SameSite=Lax; Secure";

/** The only Content-Types the unlock surface accepts (ADR 0041 decision 3). */
const FORM_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data"]);
const INVALID_FORM_MESSAGE =
  "Unlock requests must be sent as an HTML form (application/x-www-form-urlencoded or multipart/form-data).";

/**
 * Reads the unlock POST body as a FormData object. The surface only accepts
 * HTML form submissions. Every failure mode — an unsupported Content-Type
 * (text/plain, application/json, …), a malformed urlencoded body, a multipart
 * boundary mismatch, or a missing Content-Type (workerd's formData() rejects
 * it) — surfaces as a typed 400 `invalid_form_data`, never the generic 500
 * boundary (AC 8; validator probes A–D). An absent/empty Content-Type is
 * treated as a parse attempt rather than an up-front rejection, so a body
 * that parses (e.g. a null body) still follows the normal password checks.
 */
async function readUnlockForm(request: Request): Promise<FormData> {
  const mime =
    (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime !== "" && !FORM_TYPES.has(mime)) {
    throw new AppError("invalid_form_data", 400, INVALID_FORM_MESSAGE);
  }
  try {
    return await request.formData();
  } catch (error) {
    throw new AppError("invalid_form_data", 400, INVALID_FORM_MESSAGE, {
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}

/**
 * Serves the public unlock surface for a classified `unlock` route.
 * Non-unlock routes passed directly return a clean 404 (mirrors serveEntry).
 */
export async function serveUnlock(request: Request, deps: UnlockDependencies): Promise<Response> {
  const url = new URL(request.url);
  const route = classifyPath(url.pathname);
  if (route.type !== "unlock") {
    return clean404Response(url);
  }
  const id = route.id;

  if (request.method === "GET") {
    const page = await deps.pages.getById(id); // throws invalid_id (400) for bad formats
    if (page === null || page.password_hash === null) {
      return clean404Response(url);
    }
    return promptResponse(deps, id);
  }

  if (request.method !== "POST") {
    throw new AppError("method_not_allowed", 405, "Method Not Allowed");
  }

  // Page checks run FIRST so unknown and unprotected ids are indistinguishable
  // from each other (404), and no password shape ever probes protection state.
  const page = await deps.pages.getById(id);
  if (page === null || page.password_hash === null) {
    return clean404Response(url);
  }

  const form = await readUnlockForm(request);
  const validation = validatePassword(form.get("password"));
  if (validation.status !== "valid") {
    const message = validation.status === "invalid" ? validation.message : "Password is required.";
    throw new AppError("invalid_password", 400, message);
  }

  const matches = await verifyPassword(validation.value, page.password_hash);
  if (!matches) {
    return promptResponse(deps, id, "Incorrect password.");
  }

  // Rotating token: upsert stores only the SHA-256 hex of the raw token, so a
  // re-unlock invalidates the previous cookie (ADR 0041 decision 1).
  const token = generateToken();
  await deps.unlocks.create(id, await hashToken(token));

  const headers = deps.cache.headersFor("protected");
  headers.set("Location", `/p/${id}/`);
  headers.set("Set-Cookie", `${COOKIE_NAME}=${formatUnlockCookie(id, token)}; ${COOKIE_ATTRS}`);
  return new Response(null, { status: 303, headers });
}

/**
 * Total cookie-gate predicate used by the protected page path (and by
 * serveUnlock indirectly). False for: no/duplicate/malformed cookie values
 * (malformed == absent), cookies for a different page, a missing unlock row
 * (stale cookie), and a token whose hash does not match the stored hash —
 * compared in constant time.
 */
export async function hasValidUnlockCookie(
  request: Request,
  pageId: string,
  unlocks: Pick<UnlocksRepository, "getByPageId">,
): Promise<boolean> {
  const cookie = readCookie(request, COOKIE_NAME);
  if (cookie === null) {
    return false;
  }
  const parsed = parseUnlockCookie(cookie);
  if (parsed === null || parsed.pageId !== pageId) {
    return false;
  }
  const row = await unlocks.getByPageId(pageId);
  if (row === null) {
    return false;
  }
  const actual = await hashToken(parsed.token);
  return constantTimeEqual(
    new TextEncoder().encode(actual),
    new TextEncoder().encode(row.tokenHash),
  );
}

/** Returns the prompt page; an optional error renders as an escaped inline alert. */
function promptResponse(deps: UnlockDependencies, id: string, error?: string): Response {
  const headers = deps.cache.headersFor("protected");
  headers.set("Content-Type", "text/html; charset=utf-8");
  const body = renderPasswordPrompt({
    siteName: deps.config.siteName,
    action: `/p/${id}/unlock`,
    error,
  });
  return new Response(body, { status: 200, headers });
}

/**
 * Total named-cookie reader for the raw `Cookie` header: splits on `;`, trims,
 * matches the name exactly. Never throws on malformed headers.
 */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) {
    return null;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}
