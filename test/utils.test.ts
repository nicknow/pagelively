import { describe, expect, it } from "vitest";
import { escapeHtml } from "../src/utils";

// escapeHtml — shared HTML-attribute escaping (architecture 02: utils.ts).
// First consumer is the S04 base injector; S05 (markdown raw-HTML mode) and
// S19 (admin UI) reuse it.

describe("escapeHtml (utils.ts)", () => {
  it("escapes the five HTML-special characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("escapes & first so existing entities are not double-escaped", () => {
    expect(escapeHtml("a&b")).toBe("a&amp;b");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("leaves plain text unchanged", () => {
    expect(escapeHtml("hello world 123")).toBe("hello world 123");
  });

  it("returns an empty string for empty input", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("passes unicode and control-free content through unchanged", () => {
    expect(escapeHtml("café — 日本語 🚀")).toBe("café — 日本語 🚀");
  });

  it("escapes characters embedded in an otherwise normal URL", () => {
    expect(escapeHtml('https://x/a" onload="b')).toBe("https://x/a&quot; onload=&quot;b");
  });
});
