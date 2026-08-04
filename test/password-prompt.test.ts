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
