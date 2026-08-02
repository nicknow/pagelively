/**
 * S04 — serve-time `<base>`-tag injection (spec §6, ADR 0008/0013, architecture
 * 02). Pure module: string in, string out — no DOM parser, no bindings, and it
 * NEVER throws (S04 AC 3 & 6): any input, including empty, malformed, or
 * adversarial strings, yields a document containing exactly one injected base.
 *
 * Contract (ADR 0013):
 * - The base is injected as the FIRST element inside `<head>`, immediately
 *   after the first real `<head>` opening tag's `>` (attributes, case
 *   variants, `<head >`, and `<head/>` are all accepted — browsers ignore the
 *   self-closing flag on non-void elements).
 * - "Real" means a well-formed opening tag whose name is exactly `head`,
 *   found OUTSIDE HTML comments, attribute values, and the contents of
 *   raw-text elements (`script`, `style`, `textarea`, `title`, `iframe`,
 *   `noembed`, `noframes`, `noscript`, `xmp`), `<template>` (inert content),
 *   and `<plaintext>` (which makes the rest of the document literal text).
 *   Unterminated tags and declarations consume the rest of the input (the
 *   HTML5 tokenizer's eof-in-tag / bogus-comment rules), so nothing after an
 *   unterminated tag is a real tag.
 * - If no real head exists, one is created containing the base and placed
 *   after any leading BOM/whitespace, leading `<!...>` (comments/doctype,
 *   incl. doctype internal subsets, which end at `]>`), and a leading
 *   `<html>` opening tag if present — browser-like placement (head inside
 *   `<html>`, after the doctype). Never inside an unclosed comment.
 * - Every well-formed pre-existing `<base>` opening tag in scanned markup is
 *   removed before injection (case-insensitive), so exactly one active base
 *   remains (S04 AC 4).
 * - The href is HTML-attribute-escaped (S04 AC 5) and normalized: any query
 *   string or fragment is stripped (S04 AC 2; `ASSET_BASE_URL` validation
 *   itself belongs to config.ts). The caller composes the full file-style CDN
 *   href `{ASSET_BASE_URL}/pages/{id}/{rev}/{entry_path}` and the caller's
 *   path is preserved as-is, including any trailing `/`. An empty href
 *   normalizes to `/`.
 */

import { escapeHtml } from "./utils";

/**
 * Element contents treated as raw/inert text: no tags inside are real.
 * `template` is included because its content is inactive markup — a `<head>`
 * there must not swallow the injected base, and a `<base>` there never
 * affects the live document (ADR 0013 decision 3). The set covers every
 * HTML5 RAWTEXT element (script, style, textarea, title, iframe, noembed,
 * noframes, noscript, xmp); `plaintext` is special-cased in scanTags because
 * it makes the remainder of the document literal text with no closing tag.
 */
const RAW_TEXT_ELEMENTS = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "template",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "xmp",
]);

/** Chars treated as inter-token whitespace (incl. BOM and Unicode spaces). */
const WHITESPACE = " \t\n\r\f\v\u00a0\u2028\u2029\ufeff";

/** A well-formed opening tag found by the scanner: name + span in the input. */
interface TagSpan {
  name: string;
  start: number;
  end: number; // index just past the tag's closing '>'
}

/**
 * Injects `<base href="{baseHref}">` into `html` per the module contract.
 * Total: never throws on any input (S04 AC 6).
 */
export function injectBase(html: unknown, baseHref: unknown): string {
  const doc = toSafeString(html);
  const href = normalizeHref(toSafeString(baseHref));
  const baseTag = `<base href="${escapeHtml(href)}">`;

  // Replace existing bases first (S04 AC 4), then find the head in the
  // stripped document — removal cannot create or destroy tags, so this is
  // equivalent to computing both on the original text.
  const stripped = removeBaseTags(doc);
  const headEnd = findFirstHeadEnd(stripped);
  if (headEnd !== -1) {
    return stripped.slice(0, headEnd) + baseTag + stripped.slice(headEnd);
  }
  // S04 AC 3: no real head — create one containing the base.
  const insertAt = findHeadInsertionPoint(stripped);
  return stripped.slice(0, insertAt) + `<head>${baseTag}</head>` + stripped.slice(insertAt);
}

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

/** Coerces any runtime value to a string without ever throwing (S04 AC 6). */
function toSafeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return ""; // e.g. Symbol — the function still returns a valid document
  }
}

/**
 * Defensive href normalization (S04 AC 2): truncate at the FIRST of `?`/`#`
 * (whichever comes first — a `#` inside a query still starts the fragment),
 * then preserve the caller's path as-is. Empty href normalizes to `/`. No URL
 * encoding and no trimming: config validation of `ASSET_BASE_URL` is
 * config.ts's concern, not this function's.
 */
function normalizeHref(href: string): string {
  let end = href.length;
  const query = href.indexOf("?");
  const fragment = href.indexOf("#");
  if (query !== -1 && (fragment === -1 || query < fragment)) {
    end = query;
  } else if (fragment !== -1 && (query === -1 || fragment < query)) {
    end = fragment;
  }
  const stripped = href.slice(0, end);
  return stripped === "" ? "/" : stripped;
}

// ---------------------------------------------------------------------------
// Scanner primitives
// ---------------------------------------------------------------------------

function isAsciiLetter(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"));
}

/**
 * ASCII-aware case-insensitive prefix compare. Tag names are ASCII, so this is
 * safe where `toLowerCase()` is not (Unicode case folding can change string
 * length, which would corrupt index arithmetic).
 */
function asciiStartsWithIgnoreCase(text: string, pos: number, word: string): boolean {
  if (pos + word.length > text.length) return false;
  for (let i = 0; i < word.length; i++) {
    const a = text.charCodeAt(pos + i);
    const b = word.charCodeAt(i); // word is lowercase ASCII
    const lowerA = a >= 65 && a <= 90 ? a + 32 : a;
    if (lowerA !== b) return false;
  }
  return true;
}

/**
 * Whether the char at `pos` is a tag-name boundary: whitespace, `/`, or `>`.
 * A name matched with a boundary is an EXACT match — `<head>` matches but
 * `<header>`, `<head-1>`, and `<head.foo>` do not (ADR 0013 decision 3).
 */
function hasTagBoundary(text: string, pos: number): boolean {
  const after = text[pos];
  return after === ">" || after === "/" || WHITESPACE.includes(after);
}

/**
 * Whether `text` has a full tag named `name` at `pos` (`<name` + boundary).
 * Boundary = whitespace, `/`, or `>` — so `<head>` matches but `<header>`
 * does not; `<head` at EOF does not (unterminated tags are literal text).
 */
function isTagNameAt(text: string, pos: number, name: string): boolean {
  if (text.charCodeAt(pos) !== 0x3c /* '<' */) return false;
  if (!asciiStartsWithIgnoreCase(text, pos + 1, name)) return false;
  return hasTagBoundary(text, pos + 1 + name.length);
}

/** Index just past the tag-name run starting at `from` (after `<`/`</`), or -1. */
function readTagNameEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && isAsciiLetter(text[i])) i++;
  return i === from ? -1 : i;
}

/**
 * Index just past the tag's closing `>` starting after the tag name
 * (quote-aware, so `>` inside an attribute value does not end the tag), or -1
 * if the tag is unterminated — treated as literal text, never a tag.
 */
function skipTagEnd(text: string, from: number): number {
  let quote = ""; // "" = outside quotes; otherwise the active quote char
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i + 1;
    }
  }
  return -1;
}

/**
 * Index of the `[` opening a DOCTYPE internal subset, scanning quote-aware
 * (PUBLIC/SYSTEM identifiers are quoted) and stopping at the token's `>`, or
 * -1 if there is no subset or the token ends first.
 */
function findDoctypeSubsetStart(text: string, from: number): number {
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote !== "") {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[") {
      return i;
    } else if (ch === ">") {
      return -1;
    }
  }
  return -1;
}

/**
 * Index just past the closing `>` of a markup declaration (`<!...>`) starting
 * at `from` (just past the `<!`), or -1 if unterminated. A DOCTYPE carrying an
 * internal subset `[ … ]` ends at the first `]` followed by optional
 * whitespace and `>` — per HTML5 the subset content is raw (quotes and `>`
 * inside it are data, not syntax), and a `]` followed by anything else is a
 * parse error that continues the subset.
 */
function skipDeclarationEnd(text: string, from: number): number {
  if (asciiStartsWithIgnoreCase(text, from, "doctype")) {
    const bracket = findDoctypeSubsetStart(text, from);
    if (bracket !== -1) {
      for (let i = bracket + 1; i < text.length; i++) {
        if (text[i] !== "]") continue;
        let j = i + 1;
        while (j < text.length && WHITESPACE.includes(text[j])) j++;
        if (j < text.length && text[j] === ">") return j + 1;
      }
      return -1; // eof-in-doctype: the token consumes the rest of the input
    }
  }
  return skipTagEnd(text, from);
}

/**
 * Position of the `</name` that closes a raw-text element (case-insensitive,
 * boundary = whitespace, `/`, `>`, or EOF), or -1. An unclosed raw-text
 * element runs to the end of the document (matches browser behavior for
 * `<script>` and the inert-content rule for `<template>`).
 */
function findRawTextClose(text: string, from: number, name: string): number {
  const needle = `</${name}`;
  for (let i = from; i + needle.length <= text.length; i++) {
    if (!asciiStartsWithIgnoreCase(text, i, needle)) continue;
    const after = i + needle.length;
    if (after === text.length) return i; // EOF boundary
    const ch = text[after];
    if (ch === ">" || ch === "/" || WHITESPACE.includes(ch)) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// The scanner and its consumers
// ---------------------------------------------------------------------------

/**
 * Walks `text` and collects every well-formed opening tag OUTSIDE comments,
 * attribute values (tags are skipped whole, quote-aware), and raw-text /
 * template contents. Names are matched EXACTLY (boundary = whitespace, `/`,
 * `>`; ADR 0013 decision 3), so `<head1>` is not `<head>` — such tags are
 * skipped whole with their contents still scanned. Unterminated tags and
 * declarations are literal text. O(n); no regex (no ReDoS surface on
 * adversarial input).
 */
function scanTags(text: string): TagSpan[] {
  const tags: TagSpan[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    if (text.startsWith("<!--", lt)) {
      // Comment: skipped until `-->`; an unclosed comment runs to the end.
      const close = text.indexOf("-->", lt + 4);
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (text.startsWith("<!", lt)) {
      // Doctype / declaration: skipped whole (quote-aware; DOCTYPE internal
      // subsets end at `]>` per HTML5). An unterminated declaration is a
      // bogus comment / eof-in-doctype — it consumes the rest of the input,
      // so nothing after it is a real tag.
      const end = skipDeclarationEnd(text, lt + 2);
      i = end === -1 ? n : end;
      continue;
    }
    if (text.startsWith("</", lt)) {
      // Closing tag: skipped whole — never a candidate opening tag.
      const nameEnd = readTagNameEnd(text, lt + 2);
      if (nameEnd === -1) {
        i = lt + 1;
      } else {
        const end = skipTagEnd(text, nameEnd);
        i = end === -1 ? n : end;
      }
      continue;
    }
    const nameEnd = readTagNameEnd(text, lt + 1);
    if (nameEnd === -1) {
      i = lt + 1; // `<` not followed by a letter — literal text, not a tag
      continue;
    }
    const end = skipTagEnd(text, nameEnd);
    if (end === -1) {
      // Unterminated tag — eof-in-tag per HTML5: the rest of the input is
      // part of this (ignored) tag, so it is all literal text. Consuming to
      // the end also keeps the scan O(n): each input position is visited
      // once, and 'a<a<a<…' runs cannot trigger rescanning.
      i = n;
      continue;
    }
    if (!hasTagBoundary(text, nameEnd)) {
      // EXACT-name matching (ADR 0013 decision 3): readTagNameEnd stops at
      // the first non-letter, so <head1>/<head-1>/<base.foo> would truncate
      // to "head"/"base" — only a whitespace/`/`/`>` boundary makes the run
      // an exact match. `<header>` is a different name (harmless: consumers
      // filter by exact name), but `<head1>` and `<base-1>` MUST NOT be seen
      // as head/base (reviewer fix: a custom element like <base-1> would be
      // silently deleted from served output). The tag is skipped whole; its
      // contents are still scanned (it is a normal element, not raw text).
      i = end;
      continue;
    }
    const name = text.slice(lt + 1, nameEnd).toLowerCase();
    tags.push({ name, start: lt, end });
    if (name === "plaintext") {
      // HTML5: <plaintext> makes the REST of the document literal text —
      // even a "</plaintext>" is literal. Nothing after it is a real tag.
      i = n;
      continue;
    }
    if (RAW_TEXT_ELEMENTS.has(name)) {
      // Skip the element's contents: tags inside raw text / inert template
      // content are not real (see the module docstring).
      const close = findRawTextClose(text, end, name);
      i = close === -1 ? n : close;
    } else {
      i = end;
    }
  }
  return tags;
}

/** End (index just past `>`) of the FIRST real `<head>` opening tag, or -1. */
function findFirstHeadEnd(text: string): number {
  for (const tag of scanTags(text)) {
    if (tag.name === "head") return tag.end;
  }
  return -1;
}

/**
 * Removes every well-formed `<base>` opening tag in scanned markup
 * (case-insensitive, anywhere in the document — S04 AC 4). Tags inside
 * comments, attributes, and raw-text/template content are untouched.
 */
function removeBaseTags(text: string): string {
  const spans = scanTags(text).filter((tag) => tag.name === "base");
  if (spans.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/**
 * Where a CREATED head goes (S04 AC 3): after leading BOM/whitespace, any
 * leading `<!...>` (comments + doctype), and a leading `<html>` opening tag
 * if present — i.e. the head is placed inside `<html>`, after the doctype,
 * like a browser would. Falls back to the start of the string. An unclosed
 * leading comment/declaration is never entered (the head goes before it).
 */
function findHeadInsertionPoint(text: string): number {
  const n = text.length;
  let pos = skipWhitespace(text, 0);
  while (pos < n) {
    const tokenStart = pos;
    if (text.startsWith("<!--", pos)) {
      const close = text.indexOf("-->", pos + 4);
      if (close === -1) return tokenStart; // unclosed comment — do not insert inside it
      pos = skipWhitespace(text, close + 3);
      continue;
    }
    if (text.startsWith("<!", pos)) {
      const end = skipDeclarationEnd(text, pos + 2);
      if (end === -1) return tokenStart; // unclosed declaration — literal text
      pos = skipWhitespace(text, end);
      continue;
    }
    if (isTagNameAt(text, pos, "html")) {
      const end = skipTagEnd(text, pos + 5); // pos + 1 ('<') + 4 ('html')
      if (end === -1) return tokenStart; // unclosed <html — not a real tag
      pos = skipWhitespace(text, end);
      break; // the leading <html> opening is the last preamble piece
    }
    break;
  }
  return pos;
}

function skipWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && WHITESPACE.includes(text[i])) i++;
  return i;
}
