/**
 * T5-A — Template system barrel export and registry (ADR 0053).
 * Pure module: exports the default template and provides a registry for
 * future template selection.
 *
 * Contract:
 * - `renderDefaultTemplate(content)` / `DEFAULT_TEMPLATE_CSS` re-exported from
 *   `./default` for convenient single-import access.
 * - `renderTemplate(name, content)` looks up a template by name in the registry.
 *   Unknown names fall back to the default template (OQ-26 recommendation —
 *   never fail on template selection).
 * - `TemplateRegistry` is the function signature used by all templates.
 */

import { renderDefaultTemplate, DEFAULT_TEMPLATE_CSS } from "./default";

/** Signature for a template render function: content string in, full HTML out. */
export type TemplateRenderFunction = (content: string) => string;

/** Internal registry mapping template names to render functions. */
const registry = new Map<string, TemplateRenderFunction>([["default", renderDefaultTemplate]]);

/**
 * Renders content using a named template. Unknown template names fall back to
 * the default template (OQ-26) — never throws, never returns a partial page.
 *
 * @param name - Template name (e.g. "default"). Unknown names use default.
 * @param content - The rendered HTML content to wrap.
 * @returns A complete HTML document string.
 */
export function renderTemplate(name: string, content: string): string {
  const render = registry.get(name);
  if (!render) {
    // OQ-26: Unknown template name → fall back to default
    return renderDefaultTemplate(content);
  }
  return render(content);
}

export { renderDefaultTemplate, DEFAULT_TEMPLATE_CSS };
