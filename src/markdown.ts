/**
 * S05 — Markdown rendering pipeline (spec §7, §14, §15; ADR 0002 decision 4;
 * architecture 02; planner S05). Pure module: markdown string in, full HTML
 * document out. Depends only on `marked` and existing modules
 * (utils.ts/errors.ts) — no bindings.
 *
 * Contract:
 * - `renderMarkdown(md, opts)` renders markdown to HTML with marked (sync) and
 *   wraps it in TEMPLATE: a minimal responsive document whose <head> is a base
 *   slot for the S04 serve-time injector — the base is NEVER injected here
 *   (OQ-14: template links stay relative; base applied at serve time).
 * - Raw-HTML policy (ADR 0002 decision 4; §7 ALLOW_RAW_HTML_IN_MD defaults to
 *   true): allow → marked's default passthrough; false → the html/tag token
 *   renderer escapes via `escapeHtml`, so raw markup becomes inert text. No
 *   sanitizer — single-operator trust model (risk R12); escaping only makes
 *   the raw markup visible instead of executable.
 * - `showSource: true` appends a relative link to the raw file (`source.md`,
 *   OQ-14). Kind-gating of showSource (non-markdown kinds → ignored) is the
 *   CALLER's boundary (S17 entry-serve): this module only ever renders
 *   markdown, so the option surface is typed to exactly two booleans and any
 *   extra keys are dropped by destructuring — the surface cannot express an
 *   unknown option combination.
 * - Renderer failure (malformed/adversarial input, non-string) throws a typed
 *   AppError (markdown_render_failed, 500) carrying the cause in `detail` — a
 *   failed publish never yields a half-written page (S05 AC failure; surfaced
 *   at S17).
 *
 * marked v18 notes (verified against 18.0.7): per-call `{ renderer: {...} }`
 * options are not supported (throws "this.renderer.heading is not a
 * function") and `marked.use()` mutates the global singleton — so two isolated
 * `new Marked()` instances are built once at module load, one per policy, and
 * the global marked is never touched. The custom `html` renderer receives
 * BOTH block (Tokens.HTML) and inline (Tokens.Tag) raw-HTML tokens.
 */

import { Marked } from "marked";
import type { RendererObject, Tokens } from "marked";
import { escapeHtml } from "./utils";
import { AppError } from "./errors";

/**
 * Options accepted by `renderMarkdown`. Exactly two booleans; unknown keys are
 * ignored (see module docstring). Config.ts's env parsing of
 * `ALLOW_RAW_HTML_IN_MD` lands in a later slice — here the value is a typed,
 * defaulted option.
 */
export interface MarkdownRenderOptions {
  /** Pass raw HTML through as-is (default true, §7). false → escaped to text. */
  allowRawHtml?: boolean;
  /** Append a relative link to the raw source file (`source.md`, OQ-14). */
  showSource?: boolean;
}

/** Slot in TEMPLATE where the rendered body (and optional source link) goes. */
const CONTENT_SLOT = "{{CONTENT}}";

/**
 * The minimal document template (S05 AC 2): `<html>`, `<head>` carrying the
 * base slot + charset + responsive viewport meta, and a `<main>` container
 * with a readable typography class. No external CSS/JS; no base tag — the S04
 * injector inserts it at serve time as the first element of `<head>`.
 */
const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<main class="markdown-body">
${CONTENT_SLOT}</main>
</body>
</html>
`;

/**
 * The show-source link (S05 AC 3; OQ-14): relative `source.md`, resolved by
 * the serve-time base tag.
 */
const SOURCE_LINK = `<p class="source-link"><a href="source.md">View source</a></p>`;

/**
 * Escaping renderer for ALLOW_RAW_HTML_IN_MD=false (ADR 0002 decision 4):
 * every raw-HTML token — block (Tokens.HTML) and inline (Tokens.Tag) — is
 * escaped to inert text via the shared `escapeHtml`. Entities inside the raw
 * markup are escaped again (&amp; → &amp;amp;) so the browser displays the
 * literal source text rather than re-decoding it.
 */
const escapeHtmlRenderer: RendererObject = {
  html({ text }: Tokens.HTML | Tokens.Tag): string {
    return escapeHtml(text);
  },
};

// Two isolated parsers, built once at load (see marked v18 notes above).
const passthroughMarked = new Marked();
const escapingMarked = new Marked();
escapingMarked.use({ renderer: escapeHtmlRenderer });

/**
 * Renders markdown into a full HTML document per S05 AC 1-2. Synchronous and
 * deterministic; the caller (S17 publish path) applies `injectBase` at serve
 * time (OQ-14). Throws AppError (`markdown_render_failed`, 500) when marked
 * cannot render the input — never returns a partial page (S05 AC failure).
 */
export function renderMarkdown(markdown: string, options?: MarkdownRenderOptions): string {
  const { allowRawHtml = true, showSource = false } = options ?? {};
  let body: string;
  try {
    body = (allowRawHtml ? passthroughMarked : escapingMarked).parse(markdown, {
      async: false,
    });
  } catch (err) {
    throw new AppError("markdown_render_failed", 500, "Markdown content could not be rendered.", {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
  const sourceLink = showSource ? SOURCE_LINK : "";
  // Function replacement, NOT a string replacement value: a string would be
  // scanned for `$` substitution patterns (`$&`, `$'`, "$\`", `$$`), letting
  // user content containing them corrupt the document (e.g. `$$` collapses to
  // `$`, `$&` re-injects `{{CONTENT}}`, `$'` splices the template tail into the
  // body). A function is called once with the slot text and returned verbatim.
  return TEMPLATE.replace(CONTENT_SLOT, () => body + sourceLink);
}
