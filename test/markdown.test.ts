import { describe, expect, it } from "vitest";
import { renderMarkdown, type MarkdownRenderOptions } from "../src/markdown";
import { injectBase } from "../src/base-inject";
import { AppError } from "../src/errors";
import { DEFAULT_TEMPLATE_CSS } from "../src/templates";

// S05 AC 1-7 — Markdown rendering pipeline (spec §7, §14; ADR 0002 decision 4;
// OQ-14; architecture 02; planner S05). Pure unit tests; no bindings.
//
// Expected strings below pin marked 18.x output byte-for-byte (newlines
// included) inside the minimal template. The test-side HEAD/TAIL/wrap helpers
// re-state the template on purpose: a change to either side fails loudly.
// Raw-HTML behavior follows ADR 0002 decision 4: default true (§7) renders raw
// HTML as-is; false escapes html/tag tokens to inert text via escapeHtml — no
// sanitizer (single-operator trust model, risk R12).

const HEAD = `<!doctype html>
<html lang="en">
<head>
<style>
${DEFAULT_TEMPLATE_CSS}</style>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<main class="markdown-body">
`;
const TAIL = `</main>
</body>
</html>
`;
const SOURCE_LINK = `<p class="source-link"><a href="source.md">View source</a></p>`;

/** Rebuilds the expected wrapped document (test-side re-statement of the
 * template) so content-focused cases stay readable while still asserting the
 * full exact document. */
function wrap(body: string, extra = ""): string {
  return HEAD + body + extra + TAIL;
}

// ---------------------------------------------------------------------------
// Happy path (S05 AC 1-2): markdown renders to HTML inside the template.
// ---------------------------------------------------------------------------

describe("renderMarkdown — happy path (S05 AC 1-2)", () => {
  it('renders "# Hi" as <h1>Hi</h1> inside the document template', () => {
    expect(renderMarkdown("# Hi")).toBe(wrap("<h1>Hi</h1>\n"));
  });

  it("pins the exact template byte-for-byte: html, head, style, viewport, typography class", () => {
    expect(renderMarkdown("# Hi")).toBe(`<!doctype html>
<html lang="en">
<head>
<style>
${DEFAULT_TEMPLATE_CSS}</style>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<main class="markdown-body">
<h1>Hi</h1>
</main>
</body>
</html>
`);
  });

  it("provides a real <head> base slot with no base tag of its own (OQ-14)", () => {
    const out = renderMarkdown("# Hi");
    expect(out.startsWith('<!doctype html>\n<html lang="en">\n<head>\n')).toBe(true);
    expect(out).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(out).toContain('<meta charset="utf-8">');
    expect(out).toContain('<main class="markdown-body">');
    expect(out).toContain("<style>");
    expect(out).not.toContain("<base");
  });
});

// ---------------------------------------------------------------------------
// T5-B: Template system wiring — inline CSS, template selection, fallback.
// ---------------------------------------------------------------------------

describe("renderMarkdown — template system (T5-B)", () => {
  it("includes <style> with design system CSS when no options given", () => {
    const out = renderMarkdown("# Hi");
    expect(out).toContain("<style>");
    expect(out).toContain(DEFAULT_TEMPLATE_CSS);
  });

  it("wraps content in .markdown-body container", () => {
    const out = renderMarkdown("# Hi");
    expect(out).toContain('<main class="markdown-body">');
  });

  it("contains key CSS selectors (e.g., .markdown-body h1)", () => {
    expect(DEFAULT_TEMPLATE_CSS).toContain(".markdown-body h1");
    expect(DEFAULT_TEMPLATE_CSS).toContain(".markdown-body p");
    expect(DEFAULT_TEMPLATE_CSS).toContain(".markdown-body a");
    expect(DEFAULT_TEMPLATE_CSS).toContain(".source-link");
  });

  it('renderMarkdown("# Hi", { template: "default" }) is identical to no template option', () => {
    expect(renderMarkdown("# Hi", { template: "default" })).toBe(renderMarkdown("# Hi"));
  });

  it('renderMarkdown("# Hi", { template: "unknown" }) falls back to default template (OQ-26)', () => {
    expect(renderMarkdown("# Hi", { template: "unknown" })).toBe(renderMarkdown("# Hi"));
  });

  it("renders empty string with template as a valid minimal page containing <style>", () => {
    const out = renderMarkdown("");
    expect(out).toContain("<style>");
    expect(out).toContain("</style>");
    expect(out).toContain('<main class="markdown-body">');
    expect(out).toContain("</main>");
  });

  it("template option as undefined/null uses default", () => {
    expect(renderMarkdown("# Hi", { template: undefined })).toBe(renderMarkdown("# Hi"));
  });
});

// ---------------------------------------------------------------------------
// Raw-HTML policy (S05 AC 4; ADR 0002 decision 4; risk R12).
// ---------------------------------------------------------------------------

describe("renderMarkdown — raw-HTML policy (S05 AC 4)", () => {
  it("passes inline raw HTML through when allowRawHtml defaults to true (§7)", () => {
    expect(renderMarkdown("para with <b>x</b>.")).toBe(wrap("<p>para with <b>x</b>.</p>\n"));
  });

  it("passes block raw HTML through when allowRawHtml is true", () => {
    expect(renderMarkdown("<div>raw</div>\n\npara")).toBe(wrap("<div>raw</div><p>para</p>\n"));
  });

  it("passes raw <script> through when allowed (single-operator trust model, R12)", () => {
    expect(renderMarkdown("<script>alert(1)</script>")).toBe(wrap("<script>alert(1)</script>"));
  });

  it("escapes inline raw HTML to inert text when allowRawHtml is false", () => {
    expect(renderMarkdown("para with <b>x</b>.", { allowRawHtml: false })).toBe(
      wrap("<p>para with &lt;b&gt;x&lt;/b&gt;.</p>\n"),
    );
  });

  it("escapes block raw HTML when allowRawHtml is false", () => {
    expect(renderMarkdown("<div>raw</div>\n\npara", { allowRawHtml: false })).toBe(
      wrap("&lt;div&gt;raw&lt;/div&gt;<p>para</p>\n"),
    );
  });

  it("escapes <script> to inert text so it renders, never executes (R12)", () => {
    expect(renderMarkdown("<script>alert(1)</script>", { allowRawHtml: false })).toBe(
      wrap("&lt;script&gt;alert(1)&lt;/script&gt;"),
    );
  });

  it("escapes entities inside escaped raw markup exactly once (literal display)", () => {
    expect(renderMarkdown('<b title="&amp;">x</b>', { allowRawHtml: false })).toBe(
      wrap("<p>&lt;b title=&quot;&amp;amp;&quot;&gt;x&lt;/b&gt;</p>\n"),
    );
  });
});

// ---------------------------------------------------------------------------
// showSource (S05 AC 3; OQ-14): relative source.md link, opt-in.
// ---------------------------------------------------------------------------

describe("renderMarkdown — showSource (S05 AC 3; OQ-14)", () => {
  it("appends a relative source.md link when showSource is true", () => {
    expect(renderMarkdown("# Hi", { showSource: true })).toBe(wrap("<h1>Hi</h1>\n", SOURCE_LINK));
  });

  it("omits the link when showSource is false (default)", () => {
    expect(renderMarkdown("# Hi")).not.toContain("source.md");
    expect(renderMarkdown("# Hi", { showSource: false })).toBe(wrap("<h1>Hi</h1>\n"));
  });

  it("combines showSource with raw-HTML escaping", () => {
    expect(renderMarkdown("<b>x</b>", { allowRawHtml: false, showSource: true })).toBe(
      wrap("<p>&lt;b&gt;x&lt;/b&gt;</p>\n", SOURCE_LINK),
    );
  });

  it("ignores unknown option keys — the surface is exactly two booleans; kind gating is caller-side (S17)", () => {
    // The "showSource on non-markdown is ignored" guard (planner AC failure)
    // is structural here: renderMarkdown only ever renders markdown, so no
    // kind option exists. Extra keys are dropped by destructuring — assert a
    // kind-carrying call behaves identically to the typed surface.
    const opts = { allowRawHtml: false, showSource: true, kind: "bundle" } as MarkdownRenderOptions;
    expect(renderMarkdown("<b>x</b>", opts)).toBe(
      wrap("<p>&lt;b&gt;x&lt;/b&gt;</p>\n", SOURCE_LINK),
    );
  });
});

// ---------------------------------------------------------------------------
// Edge cases (S05 AC 5-6): fenced code, tables, links, images, empty, UTF-8,
// no double-encoding.
// ---------------------------------------------------------------------------

describe("renderMarkdown — edge cases (S05 AC 5-6)", () => {
  it("renders fenced code blocks with a language class", () => {
    expect(renderMarkdown("```js\nconst x = 1;\n```")).toBe(
      wrap('<pre><code class="language-js">const x = 1;\n</code></pre>\n'),
    );
  });

  it("renders tables (GFM)", () => {
    expect(renderMarkdown("| a | b |\n|---|---|\n| 1 | 2 |")).toBe(
      wrap(
        "<table>\n<thead>\n<tr>\n<th>a</th>\n<th>b</th>\n</tr>\n</thead>\n<tbody><tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody></table>\n",
      ),
    );
  });

  it("renders links", () => {
    expect(renderMarkdown("[x](https://example.com)")).toBe(
      wrap('<p><a href="https://example.com">x</a></p>\n'),
    );
  });

  it("renders images", () => {
    expect(renderMarkdown("![alt](https://example.com/i.png)")).toBe(
      wrap('<p><img src="https://example.com/i.png" alt="alt"></p>\n'),
    );
  });

  it("renders an empty document as a minimal valid page", () => {
    expect(renderMarkdown("")).toBe(wrap(""));
  });

  it("passes non-ASCII / UTF-8 content through untouched", () => {
    expect(renderMarkdown("# 日本語 🚀")).toBe(wrap("<h1>日本語 🚀</h1>\n"));
  });

  it("never double-encodes: bare & and existing &amp; both yield &amp; in both modes", () => {
    expect(renderMarkdown("AT&T")).toBe(wrap("<p>AT&amp;T</p>\n"));
    expect(renderMarkdown("AT&amp;T")).toBe(wrap("<p>AT&amp;T</p>\n"));
    expect(renderMarkdown("AT&T", { allowRawHtml: false })).toBe(wrap("<p>AT&amp;T</p>\n"));
    expect(renderMarkdown("AT&amp;T", { allowRawHtml: false })).toBe(wrap("<p>AT&amp;T</p>\n"));
  });
});

// ---------------------------------------------------------------------------
// Failure mode (S05 AC 7): renderer throws -> typed AppError, never a partial
// page. S17 surfaces it as a failed publish; here we pin the throw itself.
// ---------------------------------------------------------------------------

describe("renderMarkdown — failure mode (S05 AC 7)", () => {
  it("wraps a marked throw (non-string input) in a typed AppError", () => {
    const attempt = () => renderMarkdown(123 as unknown as string);
    expect(attempt).toThrowError(AppError);
    expect(attempt).toThrowError("Markdown content could not be rendered.");
    try {
      attempt();
      throw new Error("expected renderMarkdown to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      const appErr = err as AppError;
      expect(appErr.code).toBe("markdown_render_failed");
      expect(appErr.status).toBe(500);
      expect(appErr.publicMessage).toBe("Markdown content could not be rendered.");
      expect(appErr.detail).toEqual({ cause: expect.stringContaining("input parameter") });
    }
  });

  it("wraps adversarial deep-nesting input in a typed AppError (no half-written page)", () => {
    const adversarial = "> ".repeat(10000) + "x";
    let caught: unknown;
    try {
      renderMarkdown(adversarial);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    const appErr = caught as AppError;
    expect(appErr.code).toBe("markdown_render_failed");
    expect(appErr.status).toBe(500);
    expect(appErr.detail).toEqual({
      cause: expect.stringContaining("Maximum call stack size exceeded"),
    });
  });
});

// ---------------------------------------------------------------------------
// Composition with the S04 serve-time base injector (OQ-14: template links
// stay relative; base is applied at serve time, never by renderMarkdown).
// ---------------------------------------------------------------------------

describe("renderMarkdown + injectBase composition (S04/S05, OQ-14)", () => {
  const HREF = "https://cdn.pages.acme.com/pages/abc123/4/";

  it("yields the base as the FIRST element of <head> when the caller applies injectBase", () => {
    const served = injectBase(renderMarkdown("# Hi"), HREF);
    expect(served).toBe(`<!doctype html>
<html lang="en">
<head><base href="${HREF}">
<style>
${DEFAULT_TEMPLATE_CSS}</style>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
<main class="markdown-body">
<h1>Hi</h1>
</main>
</body>
</html>
`);
    expect(served).toContain(`<head><base href="${HREF}">`);
  });

  it("yields EXACTLY ONE active base after composition — even when markdown smuggles a <base>", () => {
    // ADR 0008 d5: raw-HTML content (when allowed) cannot smuggle a base; the
    // S04 injector removes pre-existing bases so exactly one active base remains.
    const served = injectBase(
      renderMarkdown('<base href="https://evil.example/">\n\n# Hi', { allowRawHtml: true }),
      HREF,
    );
    const baseTags = served.match(/<base\b/g) ?? [];
    expect(baseTags).toHaveLength(1);
    expect(served).toContain(`<head><base href="${HREF}">`);
    expect(served).not.toContain("evil.example");
  });
});

// ---------------------------------------------------------------------------
// Validator regression: the {{CONTENT}} slot replacement must be single-pass
// and $-safe. A string replacement value would process `$` patterns in the
// rendered body — `$$` collapses to `$` (data loss), `$&` re-injects the slot,
// `$'` splices the template tail into the body. User content containing the
// literal slot text must survive (never swallowed).
// ---------------------------------------------------------------------------

describe("renderMarkdown — template slot is single-pass and $-safe (validator regression)", () => {
  it("preserves literal $$ in text in BOTH modes (no data loss)", () => {
    expect(renderMarkdown("$$")).toBe(wrap("<p>$$</p>\n"));
    expect(renderMarkdown("$$", { allowRawHtml: false })).toBe(wrap("<p>$$</p>\n"));
  });

  it("preserves $' in text (marked escapes the quote to &#39;; the $& in $&#39; must not expand)", () => {
    expect(renderMarkdown("$'")).toBe(wrap("<p>$&#39;</p>\n"));
    expect(renderMarkdown("$'", { allowRawHtml: false })).toBe(wrap("<p>$&#39;</p>\n"));
  });

  it("preserves $& / $' / $`` / $$ inside allowed raw HTML verbatim", () => {
    expect(renderMarkdown("<div>$&</div>")).toBe(wrap("<div>$&</div>"));
    expect(renderMarkdown("<div>$'</div>")).toBe(wrap("<div>$'</div>"));
    expect(renderMarkdown('<div title="$&">x</div>')).toBe(wrap('<div title="$&">x</div>'));
    // Before the fix, $' spliced the template tail (`</main></body></html>`) into the body.
    const out = renderMarkdown("<div>$'</div>");
    expect(out).toBe(wrap("<div>$'</div>"));
    expect(out).toHaveLength(wrap("<div>$'</div>").length);
    expect(out.match(/<\/main>/g)).toHaveLength(1);
    expect(out.match(/<\/html>/g)).toHaveLength(1);
  });

  it("preserves a literal $ inside an inline code span (backtick form)", () => {
    // `$`` in a code span must not expand to the template prefix.
    expect(renderMarkdown("`code $` end`")).toBe(wrap("<p><code>code $</code> end`</p>\n"));
  });

  it("does NOT swallow user markdown containing the literal slot text {{CONTENT}}", () => {
    const out = renderMarkdown("{{CONTENT}}");
    // The template's own slot is consumed; the user's copy survives as content,
    // exactly once, inside the rendered paragraph.
    expect(out).toBe(wrap("<p>{{CONTENT}}</p>\n"));
    expect(out.match(/\{\{CONTENT\}\}/g)).toHaveLength(1);
    expect(out.match(/<main/g)).toHaveLength(1);
    expect(out.match(/<\/main>/g)).toHaveLength(1);
    expect(out.match(/<\/html>/g)).toHaveLength(1);
  });

  it("keeps the document structure intact for every $-probe input", () => {
    for (const md of [
      "$$",
      "$'",
      "$&",
      "<div>$'</div>",
      "<div>$&</div>",
      "{{CONTENT}}",
      "a $ b",
      "price: $$5",
      "<b>$</b>",
    ]) {
      for (const opts of [{}, { allowRawHtml: false }]) {
        const out = renderMarkdown(md, opts);
        expect(out.match(/<main/g), `${md} ${JSON.stringify(opts)}`).toHaveLength(1);
        expect(out.match(/<\/main>/g), `${md} ${JSON.stringify(opts)}`).toHaveLength(1);
        expect(out.match(/<\/html>/g), `${md} ${JSON.stringify(opts)}`).toHaveLength(1);
        expect(out.startsWith("<!doctype html>"), `${md} ${JSON.stringify(opts)}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Validator probes — raw HTML in non-top-level positions (spec §7 "raw HTML
// embedded inside Markdown"; ADR 0014 d2). Code is NOT rendered: raw HTML
// inside fenced/inline code stays literal (escaped code) in BOTH modes.
// ---------------------------------------------------------------------------

describe("renderMarkdown — raw HTML inside code and containers (validator probes)", () => {
  it("keeps <script> inside a fenced code block literal in BOTH modes (code is not rendered)", () => {
    const md = "```\n<script>alert(1)</script>\n```";
    const expected = wrap("<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;\n</code></pre>\n");
    expect(renderMarkdown(md)).toBe(expected);
    expect(renderMarkdown(md, { allowRawHtml: false })).toBe(expected);
  });

  it("keeps raw HTML inside inline code literal in BOTH modes", () => {
    const md = "`<script>x</script>`";
    const expected = wrap("<p><code>&lt;script&gt;x&lt;/script&gt;</code></p>\n");
    expect(renderMarkdown(md)).toBe(expected);
    expect(renderMarkdown(md, { allowRawHtml: false })).toBe(expected);
  });

  it("escapes raw HTML inside blockquotes and lists in escape mode", () => {
    expect(renderMarkdown("> <b>x</b> and <div>y</div>", { allowRawHtml: false })).toBe(
      wrap(
        "<blockquote>\n<p>&lt;b&gt;x&lt;/b&gt; and &lt;div&gt;y&lt;/div&gt;</p>\n</blockquote>\n",
      ),
    );
    expect(renderMarkdown("- <b>a</b>\n- <i>b</i>", { allowRawHtml: false })).toBe(
      wrap("<ul>\n<li>&lt;b&gt;a&lt;/b&gt;</li>\n<li>&lt;i&gt;b&lt;/i&gt;</li>\n</ul>\n"),
    );
  });

  it("escapes raw HTML in link text in escape mode", () => {
    expect(renderMarkdown("[<b>x</b>](https://example.com)", { allowRawHtml: false })).toBe(
      wrap('<p><a href="https://example.com">&lt;b&gt;x&lt;/b&gt;</a></p>\n'),
    );
  });

  it("escapes raw HTML in image alt text in BOTH modes (alt is an attribute)", () => {
    const expected = wrap(
      '<p><img src="https://example.com/i.png" alt="&lt;b&gt;alt&lt;/b&gt;"></p>\n',
    );
    expect(renderMarkdown("![<b>alt</b>](https://example.com/i.png)")).toBe(expected);
    expect(
      renderMarkdown("![<b>alt</b>](https://example.com/i.png)", { allowRawHtml: false }),
    ).toBe(expected);
  });

  it("re-escapes entities and both quote kinds in raw-HTML attributes in escape mode (ADR 0014 d2)", () => {
    expect(
      renderMarkdown("<a href=\"x?y=1&amp;z=2\" title='it'>t</a>", { allowRawHtml: false }),
    ).toBe(
      wrap("<p>&lt;a href=&quot;x?y=1&amp;amp;z=2&quot; title=&#39;it&#39;&gt;t&lt;/a&gt;</p>\n"),
    );
    expect(renderMarkdown('<div data-x="a&b">t</div>', { allowRawHtml: false })).toBe(
      wrap("&lt;div data-x=&quot;a&amp;b&quot;&gt;t&lt;/div&gt;"),
    );
  });

  it("escapes HTML comments in escape mode, including comment-only documents", () => {
    expect(renderMarkdown("<!-- hi -->", { allowRawHtml: false })).toBe(wrap("&lt;!-- hi --&gt;"));
    expect(renderMarkdown("a <!-- c --> b", { allowRawHtml: false })).toBe(
      wrap("<p>a &lt;!-- c --&gt; b</p>\n"),
    );
  });

  it("passes HTML comments through in allow mode (comment-only doc renders verbatim)", () => {
    expect(renderMarkdown("<!-- hi -->")).toBe(wrap("<!-- hi -->"));
  });

  it("escapes closing tags and pre/table blocks in escape mode", () => {
    expect(renderMarkdown("para </b>", { allowRawHtml: false })).toBe(
      wrap("<p>para &lt;/b&gt;</p>\n"),
    );
    expect(renderMarkdown("<pre>code</pre>", { allowRawHtml: false })).toBe(
      wrap("&lt;pre&gt;code&lt;/pre&gt;"),
    );
    expect(renderMarkdown("<table><tr><td>1</td></tr></table>", { allowRawHtml: false })).toBe(
      wrap("&lt;table&gt;&lt;tr&gt;&lt;td&gt;1&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;"),
    );
  });

  it("passes an onerror-carrying <img> through in allow mode (trust model — no sanitizer, ADR 0002 d4)", () => {
    expect(renderMarkdown("<img src=x onerror=alert(1)>")).toBe(
      wrap("<img src=x onerror=alert(1)>"),
    );
  });
});

// ---------------------------------------------------------------------------
// Validator probes — robustness inputs (spec §7; S05 AC 5-6; ADR 0014 d5).
// ---------------------------------------------------------------------------

describe("renderMarkdown — robustness inputs (validator probes)", () => {
  it("normalizes CRLF line endings", () => {
    expect(renderMarkdown("# Hi\r\n\r\npara")).toBe(wrap("<h1>Hi</h1>\n<p>para</p>\n"));
  });

  it("renders a whitespace-only document as an empty page", () => {
    expect(renderMarkdown("   ")).toBe(wrap(""));
    expect(renderMarkdown("\n\n\t\n")).toBe(wrap(""));
  });

  it("handles a null/undefined options object (never crashes)", () => {
    expect(renderMarkdown("# Hi", null as unknown as MarkdownRenderOptions)).toBe(
      wrap("<h1>Hi</h1>\n"),
    );
    expect(renderMarkdown("# Hi", undefined)).toBe(wrap("<h1>Hi</h1>\n"));
    expect(renderMarkdown("# Hi", { allowRawHtml: undefined, showSource: undefined })).toBe(
      wrap("<h1>Hi</h1>\n"),
    );
  });

  it("wraps null / undefined / object / array markdown input in a typed AppError", () => {
    for (const input of [null, undefined, {}, ["x"]] as unknown[]) {
      const attempt = () => renderMarkdown(input as string);
      expect(attempt).toThrowError(AppError);
      try {
        attempt();
        throw new Error("expected renderMarkdown to throw");
      } catch (err) {
        const appErr = err as AppError;
        expect(appErr.code).toBe("markdown_render_failed");
        expect(appErr.status).toBe(500);
        expect(appErr.detail).toEqual({ cause: expect.any(String) });
      }
    }
  });

  it("deep-nesting just under the stack limit still renders (2k blockquote levels)", () => {
    const md = "> ".repeat(2000) + "x";
    expect(renderMarkdown(md)).toContain("<blockquote>");
    expect(renderMarkdown(md, { allowRawHtml: false })).toContain("<blockquote>");
  });
});
