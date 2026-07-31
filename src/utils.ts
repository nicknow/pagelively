/**
 * Shared string helpers (architecture 02: utils.ts — escapeHtml, isoDate, …).
 * The first consumer is the S04 base injector; S05 (markdown raw-HTML mode)
 * and S19 (admin UI) reuse `escapeHtml`. Pure module — no bindings.
 */

/**
 * HTML-escapes the five characters that are special in text and in quoted
 * attribute values, so a value can never break out of the markup it is
 * interpolated into (defense in depth; ADR 0008 decision 4, risk R12).
 *
 * `&` is replaced first: doing it last would re-escape the `&` of the other
 * replacement sequences (`&lt;` → `&amp;lt;`).
 */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
