# Operator smoke-test checklist

**Status:** living document — started during S06 validation; completed in S22.

This checklist covers the infrastructure seams that cannot be unit-tested locally (R2 CDN
public serving, live Cloudflare Access, custom domains, real cache HITs). The build team
never fakes these in code; the human operator verifies them against the real deployment.

## S06 — Content-type mapping (added during validation)

After publishing a page with a representative asset bundle, verify from the CDN host
(`cdn.pages.acme.com/pages/{id}/{rev}/…`) that each whitelisted extension is served with the
correct `Content-Type` header:

- [ ] `.png` → `image/png`
- [ ] `.jpg` and `.jpeg` → `image/jpeg`
- [ ] `.gif` → `image/gif`
- [ ] `.webp` → `image/webp`
- [ ] `.svg` → `image/svg+xml`
- [ ] `.avif` → `image/avif`
- [ ] `.css` → `text/css`
- [ ] `.js` → `text/javascript`
- [ ] `.woff` → `font/woff`, `.woff2` → `font/woff2`, `.ttf` → `font/ttf`, `.otf` → `font/otf`, `.eot` → `application/vnd.ms-fontobject`
- [ ] `.md` (raw source) → `text/markdown`
- [ ] `.html`/`.htm` entry document served by Worker → `text/html; charset=utf-8`
- [ ] Unknown extension (e.g. `.txt`, `.json`) → `application/octet-stream` (R2 serves the bytes, browser treats as download)
- [ ] Case-insensitive: `.PNG`, `.HTML`, `.Md` all resolve to the same MIME type as lowercase.
- [ ] Query string / fragment on asset URL (e.g. `file.png?cache=1#x`) still maps to the correct MIME type.

## Pending sections (to be filled by S20/S22)

- Cloudflare Access login/logout flow
- Worker custom domain DNS resolution
- R2 CDN serving and bandwidth egress
- Edge-cache HIT / purge-on-publish freshness
- Free-tier quota verification
- Reserved-name / traversal CDN 404 behavior

See `docs/operations/README.md` for the full provisioning and deploy guide.
