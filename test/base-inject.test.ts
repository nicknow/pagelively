import { describe, expect, it } from "vitest";
import { injectBase } from "../src/base-inject";

// S04 AC 1–6 — `<base>`-tag injection (spec §6, ADR 0008/0013, architecture 02).
// Pure unit tests; no bindings. The injected tag is exactly
// `<base href="{escaped, normalized href}">` — a void element, no self-closing slash
// (planner AC: "output is well-formed (<base href="…">)").

const HREF = "https://cdn.pages.acme.com/pages/abc123/4/";
const BASE_TAG = `<base href="${HREF}">`;

/** Well-formed `<base>` tags in a document (for "exactly one base" assertions). */
function baseTags(html: string): string[] {
  return html.match(/<base(?:\s[^>]*)?\/?>/gi) ?? [];
}

/** Asserts the result contains exactly one injected base with the expected (already
 * normalized + escaped) href, and that the result is a string. */
function expectExactlyOneBase(result: unknown, expectedTag: string): void {
  expect(typeof result).toBe("string");
  const tags = baseTags(result as string);
  expect(tags).toHaveLength(1);
  expect(tags[0]).toBe(expectedTag);
}

// ---------------------------------------------------------------------------
// Happy path (S04 AC 1): first element inside <head>, immediately after the
// opening tag — with attributes, case variants, whitespace.
// ---------------------------------------------------------------------------

describe("injectBase — happy path: first element inside <head> (S04 AC 1)", () => {
  it("injects the base as the first element of an empty <head>", () => {
    expect(injectBase("<html><head></head></html>", HREF)).toBe(
      `<html><head>${BASE_TAG}</head></html>`,
    );
  });

  it("injects immediately after <head>, before existing head content", () => {
    expect(injectBase("<head><title>t</title></head>", HREF)).toBe(
      `<head>${BASE_TAG}<title>t</title></head>`,
    );
  });

  it('injects immediately after a head with attributes (<head lang="en">)', () => {
    expect(injectBase('<head lang="en"><title>t</title></head>', HREF)).toBe(
      `<head lang="en">${BASE_TAG}<title>t</title></head>`,
    );
  });

  it("injects after a head with multiple attributes and internal spacing", () => {
    expect(injectBase("<head   data-x = 'y' ><title>t</title></head>", HREF)).toBe(
      `<head   data-x = 'y' >${BASE_TAG}<title>t</title></head>`,
    );
  });

  it("handles whitespace between the tag name and the closing '>' (<head >)", () => {
    expect(injectBase("<head ><title>t</title></head>", HREF)).toBe(
      `<head >${BASE_TAG}<title>t</title></head>`,
    );
  });

  it("matches the head tag case-insensitively (<HEAD>, <Head>, <hEaD>)", () => {
    expect(injectBase("<HEAD><title>t</title></HEAD>", HREF)).toBe(
      `<HEAD>${BASE_TAG}<title>t</title></HEAD>`,
    );
    expect(injectBase("<Head><title>t</title></Head>", HREF)).toBe(
      `<Head>${BASE_TAG}<title>t</title></Head>`,
    );
    expect(injectBase("<hEaD></hEaD>", HREF)).toBe(`<hEaD>${BASE_TAG}</hEaD>`);
  });

  it("matches uppercase <HTML> in the preamble when a head is created", () => {
    // Created-head path exercises isTagNameAt → asciiStartsWithIgnoreCase
    // against uppercase input (the <HEAD> variants above never reach it:
    // with a real head the insertion point is never computed).
    expect(injectBase("<HTML><BODY>x</BODY></HTML>", HREF)).toBe(
      `<HTML><head>${BASE_TAG}</head><BODY>x</BODY></HTML>`,
    );
  });

  it("skips raw-text content with an uppercase closing tag (<SCRIPT>…</SCRIPT>)", () => {
    // findRawTextClose compares case-insensitively, so uppercase closes are
    // recognized (and exercise the uppercase arm of the ASCII fold).
    expect(injectBase("<SCRIPT>var h = '<head>';</SCRIPT><head></head>", HREF)).toBe(
      `<SCRIPT>var h = '<head>';</SCRIPT><head>${BASE_TAG}</head>`,
    );
  });

  it("does not mistake a longer tag name for <head> (<header>)", () => {
    expect(injectBase("<header><head></head></header>", HREF)).toBe(
      `<header><head>${BASE_TAG}</head></header>`,
    );
  });

  it("survives a '>' inside a head attribute value (quote-aware tag end)", () => {
    expect(injectBase('<head lang="a>b"><title>t</title></head>', HREF)).toBe(
      `<head lang="a>b">${BASE_TAG}<title>t</title></head>`,
    );
  });
});

// ---------------------------------------------------------------------------
// Href normalization (S04 AC 2): trailing slash guaranteed; query/fragment
// stripped defensively. (ASSET_BASE_URL validation itself belongs to config.ts.)
// ---------------------------------------------------------------------------

describe("injectBase — href normalization (S04 AC 2)", () => {
  it("appends a trailing slash when the href has none", () => {
    expect(injectBase("<head></head>", "https://cdn.example.com/pages/abc/3")).toBe(
      `<head><base href="https://cdn.example.com/pages/abc/3/"></head>`,
    );
  });

  it("keeps an href that already ends with a slash unchanged", () => {
    expect(injectBase("<head></head>", "https://cdn.example.com/pages/abc/3/")).toBe(
      `<head><base href="https://cdn.example.com/pages/abc/3/"></head>`,
    );
  });

  it("strips a query string (…/3/?token=t → …/3/)", () => {
    expect(injectBase("<head></head>", "https://cdn.example.com/pages/abc/3/?token=t")).toBe(
      `<head><base href="https://cdn.example.com/pages/abc/3/"></head>`,
    );
  });

  it("strips a fragment (…/3/#top → …/3/)", () => {
    expect(injectBase("<head></head>", "https://cdn.example.com/pages/abc/3/#top")).toBe(
      `<head><base href="https://cdn.example.com/pages/abc/3/"></head>`,
    );
  });

  it("strips both query and fragment, truncating at the first of '?'/'#'", () => {
    expect(injectBase("<head></head>", "https://cdn.example.com/pages/abc/3/?a=b#c")).toBe(
      `<head><base href="https://cdn.example.com/pages/abc/3/"></head>`,
    );
    expect(injectBase("<head></head>", "https://cdn.example.com/pages/abc/3/#f?q")).toBe(
      `<head><base href="https://cdn.example.com/pages/abc/3/"></head>`,
    );
  });

  it("normalizes a bare '/' href to itself", () => {
    expect(injectBase("<head></head>", "/")).toBe(`<head><base href="/"></head>`);
  });

  it("normalizes an empty href to '/' (mechanical ends-with-slash rule)", () => {
    expect(injectBase("<head></head>", "")).toBe(`<head><base href="/"></head>`);
  });

  it("leaves a placeholder CDN base unchanged (planner AC)", () => {
    expect(injectBase("<head></head>", "https://cdn.example.com")).toBe(
      `<head><base href="https://cdn.example.com/"></head>`,
    );
  });

  it("does not trim or encode the value (no URL munging beyond slash/query rules)", () => {
    // Spaces are legal in URLs (when percent-encoded by the author); this
    // function only guarantees the HTML-attribute + trailing-slash contract.
    expect(injectBase("<head></head>", "https://x.test/a b/")).toBe(
      `<head><base href="https://x.test/a b/"></head>`,
    );
  });
});

// ---------------------------------------------------------------------------
// Head creation when absent (S04 AC 3): placement rules + doctype consideration.
// ---------------------------------------------------------------------------

describe("injectBase — head created when absent (S04 AC 3)", () => {
  it("prepends a created head to a head-less fragment", () => {
    expect(injectBase("<div>hi</div>", HREF)).toBe(`<head>${BASE_TAG}</head><div>hi</div>`);
  });

  it("prepends a created head before a <body> that starts the document", () => {
    expect(injectBase("<body>hi</body>", HREF)).toBe(`<head>${BASE_TAG}</head><body>hi</body>`);
  });

  it("places the created head inside <html>, after the opening tag", () => {
    expect(injectBase("<html><body>x</body></html>", HREF)).toBe(
      `<html><head>${BASE_TAG}</head><body>x</body></html>`,
    );
  });

  it('places the created head inside <html lang="en"> (attributes tolerated)', () => {
    expect(injectBase('<html lang="en"><body>x</body></html>', HREF)).toBe(
      `<html lang="en"><head>${BASE_TAG}</head><body>x</body></html>`,
    );
  });

  it("places the created head after a leading doctype when no <html> exists", () => {
    expect(injectBase("<!doctype html>", HREF)).toBe(`<!doctype html><head>${BASE_TAG}</head>`);
    expect(injectBase("<!DOCTYPE html>", HREF)).toBe(`<!DOCTYPE html><head>${BASE_TAG}</head>`);
  });

  it("places the created head after doctype + <html> (canonical placement)", () => {
    expect(injectBase("<!DOCTYPE html><html><body>x</body></html>", HREF)).toBe(
      `<!DOCTYPE html><html><head>${BASE_TAG}</head><body>x</body></html>`,
    );
  });

  it("skips leading comments and whitespace when placing the created head", () => {
    expect(injectBase("<!-- c --><!DOCTYPE html><html><body></body></html>", HREF)).toBe(
      `<!-- c --><!DOCTYPE html><html><head>${BASE_TAG}</head><body></body></html>`,
    );
  });

  it("skips a leading BOM before <html>", () => {
    expect(injectBase("\uFEFF<html><body>x</body></html>", HREF)).toBe(
      `\uFEFF<html><head>${BASE_TAG}</head><body>x</body></html>`,
    );
  });

  it("skips leading whitespace when prepending to whitespace-only input", () => {
    expect(injectBase(" \n\t", HREF)).toBe(` \n\t<head>${BASE_TAG}</head>`);
  });

  it("survives a '>' inside a leading <html> attribute value", () => {
    expect(injectBase('<html data-x="a>b"><body>x</body></html>', HREF)).toBe(
      `<html data-x="a>b"><head>${BASE_TAG}</head><body>x</body></html>`,
    );
  });

  it("does not insert the created head inside an unclosed leading comment", () => {
    // The unclosed `<!--` would swallow a head placed after it; the head goes
    // before the comment instead (never inside comment text).
    expect(injectBase("<!-- <head>", HREF)).toBe(`<head>${BASE_TAG}</head><!-- <head>`);
  });

  it("creates a head for an empty string", () => {
    expectExactlyOneBase(injectBase("", HREF), BASE_TAG);
    expect(injectBase("", HREF)).toBe(`<head>${BASE_TAG}</head>`);
  });
});

// ---------------------------------------------------------------------------
// Existing base replacement (S04 AC 4): any pre-existing <base> removed so
// exactly one (the injected) base remains.
// ---------------------------------------------------------------------------

describe("injectBase — existing base replaced (S04 AC 4)", () => {
  it("replaces a single existing base inside the head", () => {
    expect(
      injectBase('<head><base href="https://old.example.com/"><title>t</title></head>', HREF),
    ).toBe(`<head>${BASE_TAG}<title>t</title></head>`);
  });

  it("removes multiple bases (in and out of the head) — exactly one remains", () => {
    const doc = '<head><base href="a"><base href="b"></head><body><base href="c"></body>';
    expect(injectBase(doc, HREF)).toBe(`<head>${BASE_TAG}</head><body></body>`);
  });

  it("removes base tags case-insensitively (<BASE>, <Base>)", () => {
    expect(injectBase('<head><BASE href="x"></head>', HREF)).toBe(`<head>${BASE_TAG}</head>`);
    expect(injectBase('<head><Base href="x"></head>', HREF)).toBe(`<head>${BASE_TAG}</head>`);
  });

  it("removes an attribute-less <base>", () => {
    expect(injectBase("<head><base></head>", HREF)).toBe(`<head>${BASE_TAG}</head>`);
  });

  it("removes self-closing <base/> and <base />", () => {
    expect(injectBase("<head><base/></head>", HREF)).toBe(`<head>${BASE_TAG}</head>`);
    expect(injectBase("<head><base /></head>", HREF)).toBe(`<head>${BASE_TAG}</head>`);
  });

  it("removes bases with single-quoted or unquoted attributes", () => {
    expect(injectBase("<head><base href='x'></head>", HREF)).toBe(`<head>${BASE_TAG}</head>`);
    expect(injectBase("<head><base href=x></head>", HREF)).toBe(`<head>${BASE_TAG}</head>`);
  });

  it('removes a base carrying other attributes (<base target="_blank">)', () => {
    expect(injectBase('<head><base target="_blank"></head>', HREF)).toBe(
      `<head>${BASE_TAG}</head>`,
    );
  });

  it("does not remove a similarly-named element (<baseball>)", () => {
    expect(injectBase("<head><baseball>x</baseball></head>", HREF)).toBe(
      `<head>${BASE_TAG}<baseball>x</baseball></head>`,
    );
  });

  it("leaves an unclosed <base (no '>') as literal text, still injecting exactly one well-formed base", () => {
    expect(injectBase("<head><base href=x", HREF)).toBe(`<head>${BASE_TAG}<base href=x`);
  });

  it("removes a base outside any head (document-wide replacement)", () => {
    expect(injectBase('<base href="x"><div>hi</div>', HREF)).toBe(
      `<head>${BASE_TAG}</head><div>hi</div>`,
    );
  });

  it("leaves a base inside a <template> intact (template contents are inert)", () => {
    // Template content is inactive markup — invisible to both head detection
    // and base replacement (ADR 0013 decision 3). A base there never affects
    // the live document, so "exactly one active base" still holds.
    expect(injectBase('<head><template><base href="x"></template></head>', HREF)).toBe(
      `<head>${BASE_TAG}<template><base href="x"></template></head>`,
    );
  });
});

// ---------------------------------------------------------------------------
// Escaping (S04 AC 5): the href value is HTML-attribute-escaped (defense in
// depth, risk R12) — cannot break out of the quoted attribute.
// ---------------------------------------------------------------------------

describe("injectBase — href escaping (S04 AC 5)", () => {
  it("escapes double quotes so the value cannot break out of the attribute", () => {
    // The trailing-slash normalization (AC 2) runs before escaping, so the
    // appended "/" lands after the value, before the closing quote.
    const result = injectBase("<head></head>", 'https://x/" onload="alert(1)');
    expect(result).toBe('<head><base href="https://x/&quot; onload=&quot;alert(1)/"></head>');
    expectExactlyOneBase(result, '<base href="https://x/&quot; onload=&quot;alert(1)/">');
  });

  it("escapes & < > ' and &-first (no double-escape)", () => {
    const result = injectBase("<head></head>", "a&b<c>d'e");
    expect(result).toBe('<head><base href="a&amp;b&lt;c&gt;d&#39;e/"></head>');
  });

  it("escapes the value when the attack needs < to inject markup", () => {
    const result = injectBase("<head></head>", "https://x/<img src=x onerror=alert(1)>");
    expect(result).toBe('<head><base href="https://x/&lt;img src=x onerror=alert(1)&gt;/"></head>');
    expectExactlyOneBase(result, '<base href="https://x/&lt;img src=x onerror=alert(1)&gt;/">');
  });
});

// ---------------------------------------------------------------------------
// Head-detection guardrails: <head> inside comments, attribute values, and
// raw-text elements (script/style/textarea/title) is not a real head.
// ---------------------------------------------------------------------------

describe("injectBase — head-detection guardrails (comments/attributes/raw text)", () => {
  it("ignores <head> inside a comment and uses the real head that follows", () => {
    expect(injectBase("<!-- <head> --><head></head>", HREF)).toBe(
      `<!-- <head> --><head>${BASE_TAG}</head>`,
    );
  });

  it("ignores <head> inside an attribute value (no real head → created)", () => {
    const doc = '<div data-x="<head>"></div>';
    expect(injectBase(doc, HREF)).toBe(`<head>${BASE_TAG}</head>${doc}`);
  });

  it("ignores <head> inside script source (JS comparison)", () => {
    expect(injectBase("<script>if (a <head) {}</script><head></head>", HREF)).toBe(
      `<script>if (a <head) {}</script><head>${BASE_TAG}</head>`,
    );
  });

  it("ignores <head> inside a script string literal (no real head → created)", () => {
    const doc = `<script>var h = "<head>";</script>`;
    expect(injectBase(doc, HREF)).toBe(`<head>${BASE_TAG}</head>${doc}`);
  });

  it("ignores <head> inside style text (no real head → created)", () => {
    const doc = '<style>.a{content:"<head>"}</style>';
    expect(injectBase(doc, HREF)).toBe(`<head>${BASE_TAG}</head>${doc}`);
  });

  it("ignores <head> inside <title> text (RCDATA; no real head → created)", () => {
    expect(injectBase("<title><head></title>", HREF)).toBe(
      `<head>${BASE_TAG}</head><title><head></title>`,
    );
  });

  it("ignores <head> inside an unclosed comment (head created before it)", () => {
    expect(injectBase("<!-- <head>", HREF)).toBe(`<head>${BASE_TAG}</head><!-- <head>`);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: multiple heads, self-closing <head/>, unclosed tags, template.
// ---------------------------------------------------------------------------

describe("injectBase — edge cases", () => {
  it("uses only the FIRST real head when several exist", () => {
    expect(injectBase("<head></head><body><head></head></body>", HREF)).toBe(
      `<head>${BASE_TAG}</head><body><head></head></body>`,
    );
  });

  it("treats self-closing <head/> as the head (browsers ignore the self-closing flag on non-void elements)", () => {
    expect(injectBase("<html><head/></html>", HREF)).toBe(`<html><head/>${BASE_TAG}</html>`);
    expect(injectBase('<html><head lang="en"/></html>', HREF)).toBe(
      `<html><head lang="en"/>${BASE_TAG}</html>`,
    );
  });

  it("uses a head found after <body> (first real head anywhere is used; malformed doc)", () => {
    expect(injectBase("<body><head></head></body>", HREF)).toBe(
      `<body><head>${BASE_TAG}</head></body>`,
    );
  });

  it("ignores an unclosed <head tag (no '>') — not a real head, so one is created", () => {
    expect(injectBase("<html><head", HREF)).toBe(`<html><head>${BASE_TAG}</head><head`);
  });

  it("treats <head> inside a <template> as inert (no real head → created)", () => {
    const doc = "<template><head></head></template>";
    expect(injectBase(doc, HREF)).toBe(`<head>${BASE_TAG}</head>${doc}`);
  });

  it("leaves head-like text in attributes alone while injecting into the real head", () => {
    const doc = "<head><meta data-x=\"<base href='x'>\"></head>";
    expect(injectBase(doc, HREF)).toBe(`<head>${BASE_TAG}${doc.slice("<head>".length)}`);
  });

  it("is stable under repeated injection (serve-time path never double-bases)", () => {
    const doc = "<html><head><title>t</title></head></html>";
    const once = injectBase(doc, HREF);
    const twice = injectBase(once, HREF);
    expect(twice).toBe(once);
    expectExactlyOneBase(twice, BASE_TAG);
  });
});

// ---------------------------------------------------------------------------
// Never throws (S04 AC 6): malformed/adversarial input still returns a string
// document containing exactly one base with the right href.
// ---------------------------------------------------------------------------

describe("injectBase — never throws on malformed/adversarial input (S04 AC 6)", () => {
  const adversarialInputs = [
    "<",
    "<>",
    "< >",
    "<head",
    "<head ",
    "</head>",
    "</head", // unterminated closing tag
    "</>", // closing tag with no name
    "</5",
    "<!",
    "<!!!",
    "<!-",
    "<!--",
    "<!-- -->",
    "<!-- <head> <!--",
    "<script>",
    "<script>var x = '<head>';",
    "<script>x</script>", // closed normally
    "<script>x</script/>", // `</script/` boundary close
    "<script>x</script", // EOF boundary close (no trailing '>')
    "<script>x</script >", // whitespace boundary close
    "<script>x</scripty></script>", // `</scripty` is NOT a close — keep scanning
    "<base",
    "<base href='x'",
    '<head lang="a',
    "<head>",
    "<html><head",
    "<html ", // unterminated leading <html> in the preamble
    "</head><head>",
    "日本語<head>テキスト</head>",
    "<head>\u0000\u2028</head>",
    "a".repeat(50_000), // long input — must not blow up or hang
  ];

  it("returns a string with exactly one base for every adversarial input", () => {
    for (const input of adversarialInputs) {
      let result: unknown;
      expect(() => {
        result = injectBase(input, HREF);
      }).not.toThrow();
      expectExactlyOneBase(result, BASE_TAG);
    }
  });

  it("never throws for non-string html input (runtime totality)", () => {
    for (const bad of [null, undefined, 42, true, {}, [], Symbol("x")] as unknown[]) {
      let result: unknown;
      expect(() => {
        result = injectBase(bad as never, HREF);
      }).not.toThrow();
      expect(typeof result).toBe("string");
      expectExactlyOneBase(result, BASE_TAG);
    }
  });

  it("never throws for non-string baseHref input and still emits a normalized href", () => {
    // String() explicit coercion: String(null) = "null" → "null/" (slash
    // appended); String(Symbol) succeeds too — only toString-throwing values
    // fall back to "" (→ "/"), covered below via the evil object.
    expect(injectBase("<head></head>", null as never)).toBe(`<head><base href="null/"></head>`);
    expect(injectBase("<head></head>", undefined as never)).toBe(
      `<head><base href="undefined/"></head>`,
    );
    expect(injectBase("<head></head>", 42 as never)).toBe(`<head><base href="42/"></head>`);
  });

  it("coerces a Symbol html argument via String() (explicit coercion does not throw)", () => {
    expect(injectBase(Symbol("x") as never, HREF)).toBe(`<head>${BASE_TAG}</head>Symbol(x)`);
  });

  it("returns a head+base document when toString throws", () => {
    const evil = {
      toString(): string {
        throw new Error("boom");
      },
    };
    expect(injectBase(evil as never, HREF)).toBe(`<head>${BASE_TAG}</head>`);
  });
});

// ---------------------------------------------------------------------------
// Validator probes (S04 validation, 2026-07-31): raw-text completeness
// (RAWTEXT elements beyond the ADR 0013 enumeration), unterminated-tag
// linearity (regression for the O(n) / no-ReDoS AC), bogus comments, Unicode
// case-folding, cross-href replacement, inert bases, and spacing.
// ---------------------------------------------------------------------------

describe("injectBase — validator probes: remaining HTML5 RAWTEXT elements", () => {
  it("treats <iframe> content as raw text — a <head> there is not real", () => {
    // Per HTML5, iframe (like script/style/xmp/noembed/noframes/noscript) is a
    // RAWTEXT element: a <head> inside it is literal fallback text. Treating
    // it as real would inject the base where browsers would never activate it.
    expect(injectBase("<iframe><head></head></iframe>", HREF)).toBe(
      `<head>${BASE_TAG}</head><iframe><head></head></iframe>`,
    );
    expect(injectBase("<iframe><head></head></iframe><head></head>", HREF)).toBe(
      `<iframe><head></head></iframe><head>${BASE_TAG}</head>`,
    );
  });

  it("treats <xmp>/<noembed>/<noframes>/<noscript> contents as raw text too", () => {
    for (const name of ["xmp", "noembed", "noframes", "noscript"]) {
      // No real head anywhere → one is created at the start, so the base is
      // active in browsers regardless of the scripting flag (noscript is only
      // RAWTEXT when scripting is enabled).
      expect(injectBase(`<${name}><head></head></${name}>`, HREF)).toBe(
        `<head>${BASE_TAG}</head><${name}><head></head></${name}>`,
      );
    }
  });
});

describe("injectBase — validator probes: inert <base> preservation", () => {
  it("leaves <base> inside script/style/title/comment content untouched (ADR 0013 d4)", () => {
    // These bases are literal text, never active elements; "exactly one active
    // base" still holds. Exact-string assertions: the naive baseTags() regex
    // counts raw-text occurrences too, which is why these cannot use it.
    expect(injectBase("<script><base href=x></script><head></head>", HREF)).toBe(
      `<script><base href=x></script><head>${BASE_TAG}</head>`,
    );
    expect(injectBase("<style><base href=x></style><head></head>", HREF)).toBe(
      `<style><base href=x></style><head>${BASE_TAG}</head>`,
    );
    expect(injectBase("<title><base href=x></title><head></head>", HREF)).toBe(
      `<title><base href=x></title><head>${BASE_TAG}</head>`,
    );
    expect(injectBase("<!-- <base href=x> --><head></head>", HREF)).toBe(
      `<!-- <base href=x> --><head>${BASE_TAG}</head>`,
    );
  });
});

describe("injectBase — validator probes: bogus comments and case folding", () => {
  it("puts a created head before a bogus <!--> comment (base stays active)", () => {
    // The scanner treats an unclosed comment as running to the end of input, so
    // the head is created before it — browsers end a bogus comment immediately,
    // so the created head is the first real head and the base is active.
    expect(injectBase("<!--><head></head>", HREF)).toBe(
      `<head>${BASE_TAG}</head><!--><head></head>`,
    );
  });

  it("does not treat Unicode case-folding lookalikes as <head> (ASCII-only compare)", () => {
    // U+212A (KELVIN SIGN) lowercases to 'k' in Unicode — a length-stable but
    // non-ASCII match; the scanner must not treat <\u212AHEAD> as a head.
    expect(injectBase("<\u212AHEAD></\u212AHEAD><head></head>", HREF)).toBe(
      `<\u212AHEAD></\u212AHEAD><head>${BASE_TAG}</head>`,
    );
  });
});

describe("injectBase — validator probes: unterminated tokens consume the rest (HTML5 eof rules)", () => {
  it("treats <plaintext> as making the rest of the document literal (even </plaintext>)", () => {
    expect(injectBase("<plaintext><head></head>", HREF)).toBe(
      `<head>${BASE_TAG}</head><plaintext><head></head>`,
    );
    expect(injectBase("<plaintext></plaintext><head></head>", HREF)).toBe(
      `<head>${BASE_TAG}</head><plaintext></plaintext><head></head>`,
    );
    // A real head BEFORE <plaintext> still wins.
    expect(injectBase("<head></head><plaintext>", HREF)).toBe(
      `<head>${BASE_TAG}</head><plaintext>`,
    );
  });

  it("treats an unterminated <!… as a bogus comment running to the end", () => {
    // HTML5: <! followed by anything but --/doctype/[CDATA[ is a bogus
    // comment — it consumes everything up to the first '>' (or EOF), so the
    // <head> here is comment text. The base must land in a created head that
    // is ACTIVE in a browser, never inside the bogus comment.
    // EOF-terminated: the created head goes before the comment.
    expect(injectBase("<!x<head", HREF)).toBe(`<head>${BASE_TAG}</head><!x<head`);
    // '>'-terminated: the created head follows the comment — still active.
    expect(injectBase("<!x<head></head", HREF)).toBe(`<!x<head><head>${BASE_TAG}</head></head`);
  });

  it("treats an unterminated </tag as an end tag running to the end (eof-in-tag)", () => {
    expect(injectBase("</x<head></head", HREF)).toBe(`<head>${BASE_TAG}</head></x<head></head`);
  });
});

describe("injectBase — validator probes: DOCTYPE internal subsets", () => {
  const DTD = `<!DOCTYPE html [ <!ENTITY x "y"> ]>`;

  it("places a created head AFTER the whole doctype (never inside its internal subset)", () => {
    // The internal subset's '>' after "y" is data, not the end of the
    // doctype — per HTML5 the token runs to ']>'. A head inside the subset
    // would be inert, so the base would be inactive; the created head must
    // follow the entire doctype.
    expect(injectBase(DTD, HREF)).toBe(`${DTD}<head>${BASE_TAG}</head>`);
    expect(injectBase(`${DTD}<html></html>`, HREF)).toBe(
      `${DTD}<html><head>${BASE_TAG}</head></html>`,
    );
  });

  it("ends a subset at the first ']' followed by whitespace and '>' (parse-error ']' continues it)", () => {
    // First ']' is followed by junk → parse error → subset continues to the
    // second ']'; whitespace between ']' and '>' is allowed. The doctype ends
    // at ' ] >', so the following <head> is real and gets the base.
    expect(injectBase("<!DOCTYPE html [ a ] b ] ><head></head>", HREF)).toBe(
      `<!DOCTYPE html [ a ] b ] ><head>${BASE_TAG}</head>`,
    );
  });

  it("handles PUBLIC-identifier doctypes (quoted, no subset)", () => {
    const dtd =
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">';
    expect(injectBase(dtd, HREF)).toBe(`${dtd}<head>${BASE_TAG}</head>`);
  });

  it("treats an unterminated subset as consuming the rest of the input (eof-in-doctype)", () => {
    // No ']' → the token runs to EOF, so the <head> below is doctype data.
    expect(injectBase('<!DOCTYPE html [ <!ENTITY x "y">', HREF)).toBe(
      `<head>${BASE_TAG}</head><!DOCTYPE html [ <!ENTITY x "y">`,
    );
  });

  it("treats an unterminated doctype with no subset as running to the end", () => {
    expect(injectBase("<!doctype html", HREF)).toBe(`<head>${BASE_TAG}</head><!doctype html`);
  });
});

describe("injectBase — validator probes: replacement and escaping", () => {
  it("replaces an existing base with a DIFFERENT normalized href (replace, not merge)", () => {
    expect(
      injectBase('<head><base href="https://old.example.com/"></head>', "https://new.example.com"),
    ).toBe(`<head><base href="https://new.example.com/"></head>`);
  });

  it("escapes a spaced href without breaking the attribute (no trimming, ADR 0013 d6)", () => {
    expect(injectBase("<head></head>", ' https://x.test/ "a" ')).toBe(
      `<head><base href=" https://x.test/ &quot;a&quot; /"></head>`,
    );
  });

  it("does not treat a head inside an unterminated tag's attribute value as real", () => {
    // The unclosed quote makes the whole tail one (unterminated) tag per the
    // scanner's model — matching HTML5, where <head> here is attribute-value
    // text, so the base must land in a created head at the start instead.
    expect(injectBase('<x data="a<head></head>', HREF)).toBe(
      `<head>${BASE_TAG}</head><x data="a<head></head>`,
    );
  });

  it("is idempotent: re-injecting an already-injected document keeps exactly one base", () => {
    // ADR 0013 consequences claim idempotence; AC 4's "exactly one active
    // base" must hold under repeated application (e.g. re-serving a page).
    const once = injectBase('<head><base href="https://old.example.com/"></head>', HREF);
    expect(once).toBe(`<head>${BASE_TAG}</head>`);
    const twice = injectBase(once, HREF);
    expectExactlyOneBase(twice, BASE_TAG);
    expect(twice).toBe(`<head>${BASE_TAG}</head>`);
  });
});

describe("injectBase — validator probes: scanner linearity (no ReDoS)", () => {
  it(
    "stays fast on runs of unterminated tags ('a<a<a<…' must not blow up)",
    { timeout: 10_000 },
    () => {
      // ADR 0013 d3 / S04 AC: hand-rolled O(n) scanner, no ReDoS surface. A
      // quadratic scanner takes ~12 s on 100 KB of this input; the linear fix
      // takes milliseconds. The bound is ~100x the measured linear time.
      const cases = ["a<a".repeat(33_333), "a</a".repeat(20_000), "a<!a".repeat(20_000)];
      for (const input of cases) {
        const t0 = Date.now();
        const result = injectBase(input, HREF);
        const elapsed = Date.now() - t0;
        expect(result.length).toBeGreaterThan(input.length);
        expectExactlyOneBase(result, BASE_TAG);
        expect(elapsed).toBeLessThan(2_000);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Reviewer fix (2026-07-31): EXACT-name matching. scanTags reads tag names as
// letter-only runs; the ADR 0013 decision 3 boundary rule (whitespace `/` `>`)
// must apply there too, so <head1>/<HEAD1>/<head-1>/<head.foo> are NOT real
// <head> tags and <base-1>/<base-nav>/<base.foo> are NOT <base> tags — a custom
// element named <base-1> must never be silently deleted from served output.
// ---------------------------------------------------------------------------

describe("injectBase — exact-name matching for <head> (reviewer fix, ADR 0013 d3)", () => {
  const NEAR_MISS_HEADS = ["head1", "HEAD1", "head-1", "head.foo"] as const;

  it.each(NEAR_MISS_HEADS)(
    "does not treat <%s> as the real head — the base targets the real <head>",
    (name) => {
      expect(injectBase(`<${name}></${name}><head><title>t</title></head>`, HREF)).toBe(
        `<${name}></${name}><head>${BASE_TAG}<title>t</title></head>`,
      );
    },
  );

  it.each(NEAR_MISS_HEADS)(
    "does not treat <%s> as the real head — one is created when none exists",
    (name) => {
      expect(injectBase(`<${name}></${name}>`, HREF)).toBe(
        `<head>${BASE_TAG}</head><${name}></${name}>`,
      );
    },
  );

  it("still scans a near-miss element's contents — a real <head> inside <head1> is found", () => {
    expect(injectBase("<head1><head></head></head1>", HREF)).toBe(
      `<head1><head>${BASE_TAG}</head></head1>`,
    );
  });
});

describe("injectBase — exact-name matching for <base> (reviewer fix, ADR 0013 d3)", () => {
  const NEAR_MISS_BASES = ["base-1", "base-nav", "base.foo"] as const;

  it.each(NEAR_MISS_BASES)("preserves <%s> — only an exact <base> is removed", (name) => {
    expect(injectBase(`<head><${name}>x</${name}></head>`, HREF)).toBe(
      `<head>${BASE_TAG}<${name}>x</${name}></head>`,
    );
  });

  it.each(NEAR_MISS_BASES)("preserves <%s> while still removing an exact <base>", (name) => {
    expect(injectBase(`<head><base href='old'><${name}>x</${name}></head>`, HREF)).toBe(
      `<head>${BASE_TAG}<${name}>x</${name}></head>`,
    );
  });

  it("preserves an uppercase near-miss <BASE-NAV> (case-insensitive exact match)", () => {
    expect(injectBase("<head><BASE-NAV>x</BASE-NAV></head>", HREF)).toBe(
      `<head>${BASE_TAG}<BASE-NAV>x</BASE-NAV></head>`,
    );
  });

  it("preserves a self-closing near-miss <base-1/> while <base/> is still removed", () => {
    expect(injectBase("<head><base/><base-1/></head>", HREF)).toBe(
      `<head>${BASE_TAG}<base-1/></head>`,
    );
  });

  it("removes only the exact <base> when a near-miss precedes it", () => {
    // The injected base is the FIRST element of <head> (AC 1) — it lands
    // before the preserved <base-1>, and the exact <base> is gone.
    expect(injectBase("<head><base-1>a</base-1><base href='x'></head>", HREF)).toBe(
      `<head>${BASE_TAG}<base-1>a</base-1></head>`,
    );
  });
});
