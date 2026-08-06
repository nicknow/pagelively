import { describe, expect, it } from "vitest";
import { renderDefaultTemplate, DEFAULT_TEMPLATE_CSS, renderTemplate } from "../src/templates";

// T5-A: Template system module with default template CSS.
// Tests written first, then minimum implementation to pass.
//
// The default template produces a complete HTML document with inline CSS,
// no external resources, dark mode via @media (prefers-color-scheme: dark),
// and CSS custom properties for design tokens.

// ---------------------------------------------------------------------------
// CSS content tests
// ---------------------------------------------------------------------------

describe("DEFAULT_TEMPLATE_CSS — design tokens and rules (T5-A AC 6, 7, 9)", () => {
  it("contains CSS custom properties with design tokens", () => {
    expect(DEFAULT_TEMPLATE_CSS).toContain("--color-text");
    expect(DEFAULT_TEMPLATE_CSS).toContain("--color-bg");
    expect(DEFAULT_TEMPLATE_CSS).toContain("--font-sans");
    expect(DEFAULT_TEMPLATE_CSS).toContain("--font-mono");
    expect(DEFAULT_TEMPLATE_CSS).toContain("--max-width");
  });

  it("contains @media (prefers-color-scheme: dark) for dark mode", () => {
    expect(DEFAULT_TEMPLATE_CSS).toContain("@media (prefers-color-scheme: dark)");
  });

  it("contains typography selectors for headings, paragraphs, links", () => {
    expect(DEFAULT_TEMPLATE_CSS).toContain("h1");
    expect(DEFAULT_TEMPLATE_CSS).toContain("h2");
    expect(DEFAULT_TEMPLATE_CSS).toContain("h3");
    expect(DEFAULT_TEMPLATE_CSS).toContain("p");
    expect(DEFAULT_TEMPLATE_CSS).toContain("a");
  });

  it("contains element selectors for code, pre, img, table, blockquote", () => {
    expect(DEFAULT_TEMPLATE_CSS).toContain("code");
    expect(DEFAULT_TEMPLATE_CSS).toContain("pre");
    expect(DEFAULT_TEMPLATE_CSS).toContain("img");
    expect(DEFAULT_TEMPLATE_CSS).toContain("table");
    expect(DEFAULT_TEMPLATE_CSS).toContain("blockquote");
  });

  it("contains .source-link selector", () => {
    expect(DEFAULT_TEMPLATE_CSS).toContain(".source-link");
  });

  it("contains list styling", () => {
    expect(DEFAULT_TEMPLATE_CSS).toContain("ul");
    expect(DEFAULT_TEMPLATE_CSS).toContain("ol");
  });

  it("contains responsive max-width for images", () => {
    expect(DEFAULT_TEMPLATE_CSS).toContain("max-width");
  });
});

// ---------------------------------------------------------------------------
// renderDefaultTemplate — document structure
// ---------------------------------------------------------------------------

describe("renderDefaultTemplate — document structure (T5-A AC 2, 4, 5)", () => {
  it('produces a valid HTML document with <h1>Hi</h1> for "# Hi"', () => {
    const result = renderDefaultTemplate("<h1>Hi</h1>");
    expect(result).toContain("<!doctype html>");
    expect(result).toContain('<html lang="en">');
    expect(result).toContain("<head>");
    expect(result).toContain("</head>");
    expect(result).toContain("<body>");
    expect(result).toContain("</body>");
    expect(result).toContain('<main class="markdown-body">');
    expect(result).toContain("<h1>Hi</h1>");
    expect(result).toContain("</html>");
  });

  it("contains inline <style> with CSS inside <head>", () => {
    const result = renderDefaultTemplate("<p>test</p>");
    // The style element should be inside <head>
    const headContent = result.match(/<head>([\s\S]*)<\/head>/)?.[1] ?? "";
    expect(headContent).toContain("<style>");
    expect(headContent).toContain(DEFAULT_TEMPLATE_CSS);
  });

  it('contains <meta charset="utf-8">', () => {
    const result = renderDefaultTemplate("<p>test</p>");
    expect(result).toContain('<meta charset="utf-8">');
  });

  it('contains <meta name="viewport" content="width=device-width, initial-scale=1">', () => {
    const result = renderDefaultTemplate("<p>test</p>");
    expect(result).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
  });

  it("does NOT contain a <base> tag (base-slot contract preserved for injectBase)", () => {
    const result = renderDefaultTemplate("<p>test</p>");
    expect(result).not.toContain("<base");
  });

  it("has the style element as the first child inside <head> (base slot ready for injection)", () => {
    const result = renderDefaultTemplate("<p>test</p>");
    const headContent = result.match(/<head>([\s\S]*?)<\/head>/)?.[1] ?? "";
    const trimmed = headContent.trim();
    expect(trimmed.startsWith("<style>")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderDefaultTemplate — content integrity
// ---------------------------------------------------------------------------

describe("renderDefaultTemplate — content handling (T5-A AC 10, edge cases)", () => {
  it('wraps arbitrary content inside <main class="markdown-body">', () => {
    const result = renderDefaultTemplate("<p>Hello, world!</p>");
    const mainMatch = result.match(/<main class="markdown-body">([\s\S]*)<\/main>/);
    expect(mainMatch).not.toBeNull();
    expect(mainMatch![1].trim()).toBe("<p>Hello, world!</p>");
  });

  it("handles empty content string — produces a valid document with just the main container", () => {
    const result = renderDefaultTemplate("");
    expect(result).toContain("<!doctype html>");
    expect(result).toContain('<main class="markdown-body">');
    const mainContent = result.match(/<main class="markdown-body">([\s\S]*)<\/main>/);
    expect(mainContent).not.toBeNull();
    expect(mainContent![1].trim()).toBe("");
  });

  it("preserves special HTML characters in content", () => {
    const result = renderDefaultTemplate("<p>A &amp; B &lt; C &gt; D</p>");
    expect(result).toContain("<p>A &amp; B &lt; C &gt; D</p>");
    // Ensure no double-escaping
    expect(result).not.toContain("&amp;amp;");
  });

  it("is deterministic — same input always produces same output", () => {
    const content = "<h1>Test</h1>\n<p>Deterministic check</p>";
    const first = renderDefaultTemplate(content);
    const second = renderDefaultTemplate(content);
    const third = renderDefaultTemplate(content);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("deterministic across multiple distinct inputs", () => {
    const inputs = ["<p>a</p>", "<h2>Heading</h2>\n<pre><code>code</code></pre>", ""];
    for (const input of inputs) {
      const outputs = Array.from({ length: 3 }, () => renderDefaultTemplate(input));
      expect(outputs[0]).toBe(outputs[1]);
      expect(outputs[1]).toBe(outputs[2]);
    }
  });
});

// ---------------------------------------------------------------------------
// No external resources
// ---------------------------------------------------------------------------

describe("renderDefaultTemplate — no external resources (T5-A AC 8)", () => {
  it("has no @import in the CSS", () => {
    expect(DEFAULT_TEMPLATE_CSS).not.toContain("@import");
  });

  it("has no url( references in the CSS", () => {
    expect(DEFAULT_TEMPLATE_CSS).not.toContain("url(");
  });

  it("has no <link> element in the output", () => {
    const result = renderDefaultTemplate("<p>test</p>");
    expect(result).not.toContain("<link");
  });

  it("has no JavaScript in the output", () => {
    const result = renderDefaultTemplate("<p>test</p>");
    expect(result).not.toContain("<script");
  });
});

// ---------------------------------------------------------------------------
// renderTemplate registry
// ---------------------------------------------------------------------------

describe("renderTemplate — registry (T5-A AC 1, barrel)", () => {
  it('resolves "default" to renderDefaultTemplate', () => {
    const result = renderTemplate("default", "<h1>Hi</h1>");
    expect(result).toContain("<h1>Hi</h1>");
    expect(result).toContain("<!doctype html>");
  });

  it("falls back to default template for unknown names", () => {
    const result = renderTemplate("unknown-template-name", "<p>fallback</p>");
    expect(result).toContain("<p>fallback</p>");
    expect(result).toContain("<!doctype html>");
    expect(result).toContain(DEFAULT_TEMPLATE_CSS);
  });
});

// ---------------------------------------------------------------------------
// Barrel exports from src/templates/index.ts
// ---------------------------------------------------------------------------

describe("src/templates barrel exports", () => {
  it("exports renderDefaultTemplate as a function", () => {
    expect(typeof renderDefaultTemplate).toBe("function");
  });

  it("exports DEFAULT_TEMPLATE_CSS as a string", () => {
    expect(typeof DEFAULT_TEMPLATE_CSS).toBe("string");
    expect(DEFAULT_TEMPLATE_CSS.length).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Failure mode: non-string input is acceptable (JS coerces) or TypeScript catches
// ---------------------------------------------------------------------------

describe("renderDefaultTemplate — type coercion", () => {
  it("coerces null to string 'null' without throwing", () => {
    const result = renderDefaultTemplate(null as unknown as string);
    expect(result).toContain("<!doctype html>");
    // null coerces to "null" via String(null) in template literal
    expect(result).toContain("null");
  });

  it("coerces undefined to string 'undefined' without throwing", () => {
    const result = renderDefaultTemplate(undefined as unknown as string);
    expect(result).toContain("<!doctype html>");
    expect(result).toContain("undefined");
  });

  it("coerces numbers to string without throwing", () => {
    const result = renderDefaultTemplate(42 as unknown as string);
    expect(result).toContain("<!doctype html>");
    expect(result).toContain("42");
  });
});
