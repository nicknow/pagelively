import { describe, expect, it } from "vitest";
import { renderPasswordPrompt } from "../src/password-prompt";

// S23-A AC 7 — renderPasswordPrompt: complete inline HTML document, escaped
// site name + optional error, form → the unlock action. Never includes the
// page title or any page content (OQ-23, ADR 0041 decision 5); no external
// resources. Pure module.

const BASE_OPTS = { siteName: "Acme", action: "/p/abc123/unlock" };

// ---------------------------------------------------------------------------
// AC 7 — document structure
// ---------------------------------------------------------------------------

describe("renderPasswordPrompt — document structure (S23-A AC 7)", () => {
  it("returns a complete standalone HTML document", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html.trimStart().toLowerCase().startsWith("<!doctype html>")).toBe(true);
    expect(html).toMatch(/<html/i);
    expect(html).toMatch(/<head>/i);
    expect(html).toMatch(/<meta charset="utf-8">/i);
    expect(html).toMatch(/<body>/i);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("renders the unlock form posting to the given action", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toContain('<form method="post" action="/p/abc123/unlock">');
    expect(html).toMatch(/<\/form>/);
    expect(html.match(/<form\b/g)?.length).toBe(1);
  });

  it("renders a password input with name, type, required, and minlength=5", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toMatch(/<input[^>]*\bname="password"[^>]*>/);
    expect(html).toMatch(/<input[^>]*\btype="password"[^>]*>/);
    expect(html).toMatch(/<input[^>]*\brequired\b[^>]*>/);
    expect(html).toMatch(/<input[^>]*\bminlength="5"[^>]*>/);
  });

  it("renders a submit button", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>/);
    expect(html).toContain("Unlock");
  });

  it("shows the site name and the generic protected-page text", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toContain("Acme");
    expect(html).toContain("This page is password protected.");
  });
});

// ---------------------------------------------------------------------------
// AC 7 — escaping
// ---------------------------------------------------------------------------

describe("renderPasswordPrompt — escaping (S23-A AC 7)", () => {
  it("escapes the site name", () => {
    const html = renderPasswordPrompt({
      siteName: '<script>alert("x")</script>',
      action: "/p/abc123/unlock",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;x&quot;");
  });

  it("escapes the action attribute", () => {
    const html = renderPasswordPrompt({
      siteName: "Acme",
      action: '/p/abc/unlock?x="1"&y=2',
    });
    expect(html).toContain('action="/p/abc/unlock?x=&quot;1&quot;&amp;y=2"');
  });

  it("renders no error paragraph when no error is provided", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).not.toMatch(/<p[^>]*error/i);
  });

  it("renders an escaped inline error paragraph when an error is provided", () => {
    const html = renderPasswordPrompt({ ...BASE_OPTS, error: "<b>Wrong</b> & try again" });
    expect(html).toContain(
      '<p class="error" role="alert">&lt;b&gt;Wrong&lt;/b&gt; &amp; try again</p>',
    );
    expect(html).not.toContain("<b>Wrong</b>");
  });

  it("treats an empty-string error the same as no error", () => {
    const html = renderPasswordPrompt({ ...BASE_OPTS, error: "" });
    expect(html).not.toMatch(/<p[^>]*error/i);
  });
});

// ---------------------------------------------------------------------------
// AC 7 — OQ-23 disclosure: never page title/content; no external resources
// ---------------------------------------------------------------------------

describe("renderPasswordPrompt — disclosure & resources (OQ-23)", () => {
  it("contains no external resources: no link, script, img, url(), or http(s) src/href", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).not.toMatch(/(?:src|href)=["']https?:/i);
  });

  it("builds the document only from siteName/action/error — no page title or content slot", () => {
    const html = renderPasswordPrompt({ ...BASE_OPTS, error: "Wrong password" });
    // The only user-derived text in the document is the site name and the error.
    expect(html).toContain("Acme");
    expect(html).toContain("Wrong password");
    // No content-ish landmarks that a page body could hide in.
    expect(html).not.toMatch(/<article\b/i);
    expect(html).not.toMatch(/<nav\b/i);
    // A page title would be arbitrary user text beyond the site name — the
    // only <title> is the fixed "Password required" + site name.
    expect(html).toMatch(/<title>Password required/i);
  });
});

// ---------------------------------------------------------------------------
// Slice 9 — CSS polish: centered card, admin-palette matching hex values
// ---------------------------------------------------------------------------

describe("renderPasswordPrompt — CSS polish (Slice 9)", () => {
  it("uses the light palette body background #f8fafc", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toMatch(/body[^}]*background:\s*#f8fafc/i);
  });

  it("uses the light palette body text color #0f172a", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toMatch(/body[^}]*color:\s*#0f172a/i);
  });

  it("has a centered card (main) with white surface, border-radius 0.75rem, box-shadow", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toMatch(/main[^}]*background:\s*#ffffff/i);
    expect(html).toMatch(/main[^}]*border-radius:\s*0\.75rem/i);
    expect(html).toMatch(/main[^}]*box-shadow/i);
    expect(html).toMatch(/main[^}]*padding:\s*2rem/i);
  });

  it("has the heading styled with font-size, weight, letter-spacing", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toMatch(/h1[^}]*font-size:\s*1\.25rem/i);
    expect(html).toMatch(/h1[^}]*font-weight:\s*700/i);
  });

  it("has the description paragraph with muted color #64748b", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toMatch(/p[^}]*color:\s*#64748b/i);
  });

  it("has labels with font-weight 500", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toMatch(/label[^}]*font-weight:\s*500/i);
  });

  it("styles the password input with border #e2e8f0 and border-radius 0.5rem", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toMatch(/input\[type="password"\][^}]*border:\s*1px\s+solid\s+#e2e8f0/i);
    expect(html).toMatch(/input\[type="password"\][^}]*border-radius:\s*0\.5rem/i);
    // Should also have padding: 0.75rem and font-size: 0.9375rem
    expect(html).toMatch(/input\[type="password"\][^}]*padding:\s*0\.75rem/i);
  });

  it("styles the password input focus state with border-color #3b82f6 and ring", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toMatch(/input\[type="password"\]:focus[^}]*border-color:\s*#3b82f6/i);
    expect(html).toMatch(/input\[type="password"\]:focus[^}]*box-shadow/i);
    expect(html).toMatch(/input\[type="password"\]:focus[^}]*outline:\s*none/i);
  });

  it("styles the button with primary blue #2563eb, white text, border-radius 0.5rem", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toMatch(/button[^}]*background:\s*#2563eb/i);
    expect(html).toMatch(/button[^}]*color:\s*#ffffff/i);
    expect(html).toMatch(/button[^}]*border-radius:\s*0\.5rem/i);
    expect(html).toMatch(/button[^}]*cursor:\s*pointer/i);
  });

  it("styles the button hover state with #1d4ed8", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toMatch(/button:hover[^}]*background:\s*#1d4ed8/i);
  });

  it("styles the error element with #dc2626 danger color and #fef2f2 background", () => {
    const html = renderPasswordPrompt({ ...BASE_OPTS, error: "Wrong" });
    expect(html).toMatch(/\.error[^}]*color:\s*#dc2626/i);
    expect(html).toMatch(/\.error[^}]*font-weight:\s*500/i);
    expect(html).toMatch(/\.error[^}]*background:\s*#fef2f2/i);
    expect(html).toMatch(/\.error[^}]*border-radius:\s*0\.5rem/i);
  });

  it("has antialiased font smoothing on the body", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toMatch(/body[^}]*webkit-font-smoothing:\s*antialiased/i);
  });

  it("has an extended system-ui font stack on the body", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toMatch(/body[^}]*font-family:\s*system-ui,\s*-apple-system/i);
  });

  it("includes the dark mode @media (prefers-color-scheme: dark) block", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toMatch(/@media\s*\(prefers-color-scheme:\s*dark\)/i);
  });

  it("uses dark palette hex values inside the dark mode block", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    // Dark mode is all on one line; use greedy match to capture the full block
    const darkMatch = html.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{(.+)\}/i);
    expect(darkMatch).not.toBeNull();
    const dark = darkMatch![1];
    expect(dark).toContain("#0b1220"); // body background
    expect(dark).toContain("#16213a"); // card surface
    expect(dark).toContain("#2b3a55"); // border color
    expect(dark).toContain("#3b82f6"); // button
    expect(dark).toContain("#60a5fa"); // button hover
    expect(dark).toContain("#94a3b8"); // muted text
  });

  it("still has no external resources (link, script, url()) after CSS polish", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(/i);
    expect(html).not.toMatch(/(?:src|href)=["']https?:/i);
  });

  it("still has no page title or content slot — only site name and error", () => {
    const html = renderPasswordPrompt({ ...BASE_OPTS, error: "Wrong password" });
    expect(html).not.toMatch(/<article\b/i);
    expect(html).not.toMatch(/<nav\b/i);
    expect(html).toMatch(/<title>Password required/i);
  });

  it("preserves the form action, method, input attributes, and button unchanged", () => {
    const html = renderPasswordPrompt(BASE_OPTS);
    expect(html).toContain('<form method="post" action="/p/abc123/unlock">');
    expect(html).toMatch(/<input[^>]*\btype="password"[^>]*\brequired\b[^>]*\bminlength="5"[^>]*>/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Unlock<\/button>/);
  });

  it("preserves escaping behavior after CSS polish", () => {
    const html = renderPasswordPrompt({
      siteName: '<script>alert("x")</script>',
      action: '/p/abc/unlock?x="1"&y=2',
      error: "<b>Wrong</b> & try again",
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;x&quot;");
    expect(html).toContain('action="/p/abc/unlock?x=&quot;1&quot;&amp;y=2"');
    expect(html).toContain(
      '<p class="error" role="alert">&lt;b&gt;Wrong&lt;/b&gt; &amp; try again</p>',
    );
  });
});
