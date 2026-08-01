import { describe, expect, it } from "vitest";
import { parseFileUpdateForm, parsePublishForm } from "../src/form-parser";

// S17 — form-parser direct unit tests (covers uncovered branches in src/form-parser.ts).

function makeRequest(form: FormData): Request {
  return new Request("https://pages.example.com/api/pages", {
    method: "POST",
    body: form,
  });
}

function makeFile(name: string, content: string, type?: string): File {
  return new File([new TextEncoder().encode(content)], name, {
    type: type ?? "application/octet-stream",
  });
}

function expectAppError(promise: Promise<unknown>, code: string, status: number): Promise<void> {
  return expect(promise).rejects.toMatchObject({ code, status });
}

describe("parsePublishForm", () => {
  it("parses a manifest with every optional field", async () => {
    const form = new FormData();
    form.append(
      "manifest",
      JSON.stringify({
        slug: "my-page",
        title: "My Page",
        showSource: true,
        entry: "index.md",
        visibility: "unlisted",
      }),
    );
    form.append("file:index.md", makeFile("index.md", "# Hello", "text/markdown"));

    const result = await parsePublishForm(makeRequest(form));
    expect(result.manifest).toEqual({
      slug: "my-page",
      title: "My Page",
      showSource: true,
      entry: "index.md",
      visibility: "unlisted",
    });
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("index.md");
  });

  it("returns an empty manifest and empty files when the form is empty", async () => {
    const result = await parsePublishForm(makeRequest(new FormData()));
    expect(result.manifest).toEqual({});
    expect(result.files).toEqual([]);
  });

  it("throws invalid_manifest when the manifest field is not a string", async () => {
    const form = new FormData();
    form.append("manifest", makeFile("manifest.json", "{}"));
    await expectAppError(parsePublishForm(makeRequest(form)), "invalid_manifest", 400);
  });

  it("throws invalid_manifest when the manifest is not valid JSON", async () => {
    const form = new FormData();
    form.append("manifest", "not-json");
    await expectAppError(parsePublishForm(makeRequest(form)), "invalid_manifest", 400);
  });

  it("throws invalid_manifest when the manifest is an array", async () => {
    const form = new FormData();
    form.append("manifest", JSON.stringify(["bad"]));
    await expectAppError(parsePublishForm(makeRequest(form)), "invalid_manifest", 400);
  });

  it("throws invalid_manifest when the manifest is a number", async () => {
    const form = new FormData();
    form.append("manifest", "42");
    await expectAppError(parsePublishForm(makeRequest(form)), "invalid_manifest", 400);
  });

  it("throws invalid_file when a file: part is not a File", async () => {
    const form = new FormData();
    form.append("manifest", JSON.stringify({}));
    form.append("file:readme.txt", "just a string");
    await expectAppError(parsePublishForm(makeRequest(form)), "invalid_file", 400);
  });

  it("throws path_traversal for an empty path", async () => {
    const form = new FormData();
    form.append("file:", makeFile("empty", "x"));
    await expectAppError(parsePublishForm(makeRequest(form)), "invalid_path", 400);
  });

  it("throws path_traversal for an absolute path", async () => {
    const form = new FormData();
    form.append("file:/etc/passwd", makeFile("passwd", "x"));
    await expectAppError(parsePublishForm(makeRequest(form)), "path_traversal", 400);
  });

  it("throws path_traversal for a ../ path", async () => {
    const form = new FormData();
    form.append("file:../etc/passwd", makeFile("passwd", "x"));
    await expectAppError(parsePublishForm(makeRequest(form)), "path_traversal", 400);
  });

  it("throws path_traversal for a backslash path", async () => {
    const form = new FormData();
    form.append("file:foo\\bar.txt", makeFile("bar.txt", "x"));
    await expectAppError(parsePublishForm(makeRequest(form)), "path_traversal", 400);
  });

  it("throws invalid_filename for a percent sign in the path", async () => {
    const form = new FormData();
    form.append("file:bad%file.txt", makeFile("bad%file.txt", "x"));
    await expectAppError(parsePublishForm(makeRequest(form)), "invalid_filename", 400);
  });

  it("throws invalid_filename for a percent sign in the browser filename", async () => {
    const form = new FormData();
    // The path is clean, but the browser-supplied filename contains '%'.
    form.append("file:clean.txt", makeFile("bad%name.txt", "x"));
    await expectAppError(parsePublishForm(makeRequest(form)), "invalid_filename", 400);
  });

  it("strips a leading UTF-8 BOM from markdown content", async () => {
    const form = new FormData();
    const md = "\uFEFF# Title\n";
    form.append("file:note.md", makeFile("note.md", md, "text/markdown"));
    const result = await parsePublishForm(makeRequest(form));
    const text = new TextDecoder().decode(result.files[0].content);
    expect(text).toBe("# Title\n");
  });

  it("does not strip a leading BOM from non-markdown content", async () => {
    const form = new FormData();
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x48, 0x69]); // BOM + "Hi"
    form.append("file:note.txt", new File([bytes], "note.txt"));
    const result = await parsePublishForm(makeRequest(form));
    expect(new Uint8Array(result.files[0].content)).toEqual(bytes);
  });

  it("does not strip a non-BOM prefix from markdown", async () => {
    const form = new FormData();
    const md = "\xFF# Title\n"; // 0xFF is not the start of a UTF-8 BOM
    form.append("file:note.md", makeFile("note.md", md, "text/markdown"));
    const result = await parsePublishForm(makeRequest(form));
    const text = new TextDecoder().decode(result.files[0].content);
    expect(text).toBe("\xFF# Title\n");
  });

  it("throws request_too_large when Content-Length exceeds ~95 MB", async () => {
    const form = new FormData();
    form.append("file:x.html", makeFile("x.html", "<h1>X</h1>"));
    const request = new Request("https://pages.example.com/api/pages", {
      method: "POST",
      body: form,
      headers: { "Content-Length": "99614721" }, // 95 MB + 1 byte
    });
    await expectAppError(parsePublishForm(request), "request_too_large", 413);
  });

  it("does not throw when Content-Length is below the limit", async () => {
    const form = new FormData();
    form.append("file:x.html", makeFile("x.html", "<h1>X</h1>"));
    const request = new Request("https://pages.example.com/api/pages", {
      method: "POST",
      body: form,
      headers: { "Content-Length": "100" },
    });
    const result = await parsePublishForm(request);
    expect(result.files).toHaveLength(1);
  });

  it("throws invalid_form_data when the body is not multipart", async () => {
    const request = new Request("https://pages.example.com/api/pages", {
      method: "POST",
      body: "plain text",
      headers: { "Content-Type": "text/plain" },
    });
    await expect(parsePublishForm(request)).rejects.toMatchObject({
      code: "invalid_form_data",
      status: 400,
    });
  });

  it("throws invalid_form_data when the multipart boundary is missing", async () => {
    const request = new Request("https://pages.example.com/api/pages", {
      method: "POST",
      body: "--",
      headers: { "Content-Type": "multipart/form-data" },
    });
    await expect(parsePublishForm(request)).rejects.toMatchObject({
      code: "invalid_form_data",
      status: 400,
    });
  });

  it("throws invalid_form_data when the multipart body is malformed", async () => {
    const request = new Request("https://pages.example.com/api/pages", {
      method: "POST",
      body: "--boundary\ninvalid",
      headers: { "Content-Type": "multipart/form-data; boundary=boundary" },
    });
    await expect(parsePublishForm(request)).rejects.toMatchObject({
      code: "invalid_form_data",
      status: 400,
    });
  });

  it("ignores form parts that are not manifest or file:", async () => {
    const form = new FormData();
    form.append("manifest", JSON.stringify({}));
    form.append("file:x.html", makeFile("x.html", "<h1>X</h1>"));
    form.append("unknown", "ignored");
    const result = await parsePublishForm(makeRequest(form));
    expect(result.files).toHaveLength(1);
    expect(result.files[0].path).toBe("x.html");
  });
});

describe("parseFileUpdateForm", () => {
  function makeFileUpdateRequest(form: FormData): Request {
    return new Request("https://pages.example.com/api/pages/abc123/files", {
      method: "POST",
      body: form,
    });
  }

  it("parses file parts only", async () => {
    const form = new FormData();
    form.append("manifest", JSON.stringify({ slug: "ignored" }));
    form.append("file:style.css", makeFile("style.css", "body{}", "text/css"));
    const result = await parseFileUpdateForm(makeFileUpdateRequest(form));
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("style.css");
  });

  it("throws request_too_large when Content-Length exceeds ~95 MB", async () => {
    const form = new FormData();
    form.append("file:x.html", makeFile("x.html", "<h1>X</h1>"));
    const request = new Request("https://pages.example.com/api/pages/abc123/files", {
      method: "POST",
      body: form,
      headers: { "Content-Length": "99614721" },
    });
    await expectAppError(parseFileUpdateForm(request), "request_too_large", 413);
  });

  it("throws invalid_form_data when the body is not multipart", async () => {
    const request = new Request("https://pages.example.com/api/pages/abc123/files", {
      method: "POST",
      body: "plain text",
      headers: { "Content-Type": "text/plain" },
    });
    await expect(parseFileUpdateForm(request)).rejects.toMatchObject({
      code: "invalid_form_data",
      status: 400,
    });
  });

  it("throws invalid_form_data when the multipart boundary is missing", async () => {
    const request = new Request("https://pages.example.com/api/pages/abc123/files", {
      method: "POST",
      body: "--",
      headers: { "Content-Type": "multipart/form-data" },
    });
    await expect(parseFileUpdateForm(request)).rejects.toMatchObject({
      code: "invalid_form_data",
      status: 400,
    });
  });

  it("throws invalid_form_data when the multipart body is malformed", async () => {
    const request = new Request("https://pages.example.com/api/pages/abc123/files", {
      method: "POST",
      body: "--boundary\ninvalid",
      headers: { "Content-Type": "multipart/form-data; boundary=boundary" },
    });
    await expect(parseFileUpdateForm(request)).rejects.toMatchObject({
      code: "invalid_form_data",
      status: 400,
    });
  });

  it("returns an empty array when no file parts are present", async () => {
    const form = new FormData();
    form.append("manifest", JSON.stringify({ slug: "ignored" }));
    const result = await parseFileUpdateForm(makeFileUpdateRequest(form));
    expect(result).toEqual([]);
  });
});
