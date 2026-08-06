/**
 * T5-A — Default template for the markdown template system (ADR 0053, §7, §17).
 * Pure module: string in, full HTML document out. No bindings, no side effects,
 * no external resources — all CSS is inline (Workers-compatible).
 *
 * Contract:
 * - `DEFAULT_TEMPLATE_CSS` is a CSS string with design tokens (custom properties),
 *   typography rules, responsive layout, and dark mode via `@media (prefers-color-scheme: dark)`.
 * - `renderDefaultTemplate(content: string): string` wraps content in a complete
 *   HTML document with the CSS inlined in `<head>`. The `<head>` has no `<base>` tag
 *   — the base-slot contract is preserved for the S04 serve-time injector.
 * - The slot replacement uses a function callback for `$`-safety
 *   (same pattern as `src/markdown.ts`).
 * - The function is deterministic: same input always produces same output.
 * - No external CSS, JS, or font references. No `@import`, no `<link>`, no `url()`.
 */

// ---------------------------------------------------------------------------
// Design system CSS — inline, no external resources, dark mode via media query.
// Uses CSS custom properties for consistency and future overrides.
// Pattern follows the admin UI's DESIGN_SYSTEM_CSS (ADR 0046).
// ---------------------------------------------------------------------------

export const DEFAULT_TEMPLATE_CSS = `
:root {
  color-scheme: light;
  --color-text: #1e293b;
  --color-bg: #ffffff;
  --color-surface: #f8fafc;
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-muted: #64748b;
  --color-border: #e2e8f0;
  --color-code-bg: #f1f5f9;
  --color-code-text: #1e293b;
  --color-blockquote-border: #2563eb;
  --color-blockquote-bg: #f8fafc;
  --color-table-stripe: #f8fafc;
  --color-link-underline: rgba(37, 99, 235, 0.3);
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  --max-width: 720px;
  --line-height: 1.7;
  --heading-line-height: 1.3;
  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
}

@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --color-text: #e2e8f0;
    --color-bg: #0f172a;
    --color-surface: #1e293b;
    --color-primary: #60a5fa;
    --color-primary-hover: #93bbfd;
    --color-muted: #94a3b8;
    --color-border: #334155;
    --color-code-bg: #1e293b;
    --color-code-text: #e2e8f0;
    --color-blockquote-border: #60a5fa;
    --color-blockquote-bg: #1e293b;
    --color-table-stripe: #1e293b;
    --color-link-underline: rgba(96, 165, 250, 0.3);
  }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}

* {
  box-sizing: border-box;
}

.markdown-body {
  font-family: var(--font-sans);
  font-size: 1rem;
  line-height: var(--line-height);
  color: var(--color-text);
  background: var(--color-bg);
  max-width: var(--max-width);
  margin: 0 auto;
  padding: 1.5rem 1rem;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

@media (min-width: 640px) {
  .markdown-body {
    padding: 2rem 1.5rem;
  }
}

/* Headings */
.markdown-body h1,
.markdown-body h2,
.markdown-body h3,
.markdown-body h4,
.markdown-body h5,
.markdown-body h6 {
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  font-weight: 600;
  line-height: var(--heading-line-height);
  color: var(--color-text);
}

.markdown-body h1 {
  font-size: 2rem;
  margin-top: 0;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--color-border);
}

.markdown-body h2 {
  font-size: 1.5rem;
  padding-bottom: 0.3em;
  border-bottom: 1px solid var(--color-border);
}

.markdown-body h3 {
  font-size: 1.25rem;
}

.markdown-body h4 {
  font-size: 1.1rem;
}

.markdown-body h5 {
  font-size: 1rem;
}

.markdown-body h6 {
  font-size: 0.875rem;
  color: var(--color-muted);
}

/* Paragraphs */
.markdown-body p {
  margin-top: 0;
  margin-bottom: 1rem;
}

/* Links */
.markdown-body a {
  color: var(--color-primary);
  text-decoration: none;
}

.markdown-body a:hover {
  text-decoration: underline;
  color: var(--color-primary-hover);
}

/* Inline code */
.markdown-body code {
  font-family: var(--font-mono);
  font-size: 0.875em;
  padding: 0.2em 0.4em;
  background: var(--color-code-bg);
  color: var(--color-code-text);
  border-radius: var(--radius-sm);
}

/* Fenced code blocks */
.markdown-body pre {
  font-family: var(--font-mono);
  font-size: 0.875rem;
  line-height: 1.5;
  margin-top: 0;
  margin-bottom: 1rem;
  padding: 1rem;
  background: var(--color-code-bg);
  border-radius: var(--radius-md);
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.markdown-body pre code {
  padding: 0;
  background: none;
  border-radius: 0;
  font-size: inherit;
  color: inherit;
}

/* Images */
.markdown-body img {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 1.5rem auto;
  border-radius: var(--radius-md);
}

/* Tables */
.markdown-body table {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 1rem;
  display: block;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.markdown-body th,
.markdown-body td {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--color-border);
  text-align: left;
}

.markdown-body th {
  font-weight: 600;
  background: var(--color-surface);
}

.markdown-body tr:nth-child(even) {
  background: var(--color-table-stripe);
}

/* Blockquotes */
.markdown-body blockquote {
  margin: 0 0 1rem;
  padding: 0.5em 1em;
  border-left: 4px solid var(--color-blockquote-border);
  background: var(--color-blockquote-bg);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
}

.markdown-body blockquote p:last-child {
  margin-bottom: 0;
}

/* Lists */
.markdown-body ul,
.markdown-body ol {
  margin-top: 0;
  margin-bottom: 1rem;
  padding-left: 2em;
}

.markdown-body li {
  margin-bottom: 0.25em;
}

.markdown-body li > p {
  margin-bottom: 0.5em;
}

/* Nested lists */
.markdown-body ul ul,
.markdown-body ol ul,
.markdown-body ul ol,
.markdown-body ol ol {
  margin-bottom: 0;
}

/* Horizontal rules */
.markdown-body hr {
  height: 1px;
  padding: 0;
  margin: 1.5rem 0;
  background: var(--color-border);
  border: 0;
}

/* Source link (showSource) */
.markdown-body .source-link {
  margin-top: 2rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--color-border);
  font-size: 0.875rem;
}

.markdown-body .source-link a {
  color: var(--color-muted);
}

.markdown-body .source-link a:hover {
  color: var(--color-primary);
}
`;

// ---------------------------------------------------------------------------
// Template and slot replacement
// ---------------------------------------------------------------------------

/** Template structure with two distinct markers: {{CSS}} for the stylesheet
 * and {{CONTENT}} for the rendered body content. Using separate markers avoids
 * ambiguity and allows single-function-call replacement for $-safety. */
const CSS_MARKER = "{{CSS}}";
const CONTENT_MARKER = "{{CONTENT}}";

const TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<style>
${CSS_MARKER}</style>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<main class="markdown-body">
${CONTENT_MARKER}</main>
</body>
</html>
`;

/**
 * Renders content inside the default template with inline CSS.
 *
 * Deterministic: same input always produces same output.
 * $-safe: slot replacement uses function callbacks, avoiding `$`-interpretation.
 *
 * @param content - The rendered HTML content to wrap in the template.
 * @returns A complete HTML document string.
 */
export function renderDefaultTemplate(content: string): string {
  const withCss = TEMPLATE.replace(CSS_MARKER, () => DEFAULT_TEMPLATE_CSS);
  return withCss.replace(CONTENT_MARKER, () => content);
}
