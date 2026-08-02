# 0040: In-page fragment links: point the injected `<base>` at the entry file

- Status: accepted
- Date: 2026-08-02

## Context

The injected `<base>` tag was pointing at the page's CDN folder:

```html
<base href="https://cdn.n.3a8r.com/pages/{id}/{rev}/" />
```

This made fragment links like `<a href="#delivery">` resolve to
`https://cdn.n.3a8r.com/pages/{id}/{rev}/#delivery`. That URL is a directory URL;
the R2 CDN only stores the actual object at `.../{rev}/index.html`, so the
fragment URL 404ed (spec §6, ADR 0008, ADR 0013).

## Decision

1. **Change the injected base to the entry file itself**, e.g.:

   ```html
   <base href="https://cdn.n.3a8r.com/pages/{id}/{rev}/index.html" />
   ```

   With this value, `<a href="#delivery">` resolves to
   `.../index.html#delivery`, which is the valid CDN object URL.

2. **`entry-serve.ts` composes the full href.** `buildBaseHref(config, pageId, rev, entryPath)`
   now returns `{ASSET_BASE_URL}/pages/{id}/{rev}/{entry_path}`. For image pages the 301
   `Location` is exactly this href (the entry path is already included). For HTML / Markdown /
   bundle pages the href is passed to `injectBase`.

3. **`base-inject.ts` normalizes defensively but preserves the path.** The injector still strips
   any query string or fragment (so a stray `?token=` or `#` cannot redirect relative assets
   through a query), but it no longer appends a trailing `/`. A trailing `/` is preserved if the
   caller passes one, and an empty href still normalizes to `/`.

4. **Relative asset references still work.** Browsers resolve relative references against the
   directory containing the base URL's file. `images/pic.png` against
   `.../{rev}/index.html` still resolves to `.../{rev}/images/pic.png` (spec §6, §8).

## Consequences

- Fragment links in served HTML now resolve to the actual CDN object and return 200.
- The image-page 301 target remains the same object URL; only the code path that builds it
  changed (the folder + entry_path concatenation is now done once in `buildBaseHref`).
- `base-inject.ts` remains a total, pure function and still makes no URL-validity assumptions.
- The S04 test contract and ADR 0013 are updated to reflect the new normalization behavior.
- The spec, architecture docs, operator checklist, and ADR 0008 are updated to show the
  file-style base href.

## Cross-references

- Spec: §6 (image / asset reference resolution).
- ADRs: 0008 (serve-time `<base>` injection), 0013 (S04 injector contract).
- Docs: `docs/architecture/01-system-overview.md`, `docs/operations/smoke-test-checklist.md`.
- Source: `src/entry-serve.ts`, `src/base-inject.ts`.
