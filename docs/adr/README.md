# Decision log (`docs/adr/`)

Every significant decision is recorded as an **Architecture Decision Record (ADR)** so future
humans and agents can see _why_ the code is the way it is. Cloudflare platform facts are
verified against current official documentation and cited in the ADR — never asserted from
memory.

## ADRs

| #    | Title                                                                                                                                           | Status                           |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 0001 | [Phase 0 foundations: repo layout, toolchain, devcontainer](0001-phase-0-foundations.md)                                                        | Accepted                         |
| 0002 | [Language, runtime, and dependency policy](0002-language-runtime-dependency-policy.md)                                                          | Accepted                         |
| 0003 | [Test framework and binding emulation](0003-test-framework-binding-emulation.md)                                                                | Accepted                         |
| 0004 | [Devcontainer](0004-devcontainer.md)                                                                                                            | Accepted                         |
| 0005 | [Error handling and authentication fail-closed policy](0005-error-handling-auth-fail-closed.md)                                                 | Accepted                         |
| 0006 | [Caching model and the `rev` cache-busting scheme](0006-caching-rev-model.md)                                                                   | Accepted                         |
| 0007 | [Slugs and reserved words](0007-slugs-reserved-words.md)                                                                                        | Accepted                         |
| 0008 | [Serve-time `<base>` injection](0008-serve-time-base-injection.md)                                                                              | Accepted                         |
| 0009 | [Cache emulation seam — Workers Caching contract tests](0009-cache-emulation-seam.md)                                                           | Accepted                         |
| 0010 | [S01 implementation details — id generation, slugify, route classification](0010-s01-id-slug-router-details.md)                                 | Accepted                         |
| 0011 | [S02 implementation details — `validateSlug` reserved-word validation](0011-s02-validate-slug-reserved-words.md)                                | Accepted                         |
| 0012 | [S03 implementation details — rev bump policy and the R2 key builder](0012-s03-rev-bump-policy-key-builder.md)                                  | Accepted                         |
| 0013 | [S04 implementation details — the `<base>`-injector contract](0013-s04-base-injector.md)                                                        | Accepted                         |
| 0014 | [S05 implementation details — the markdown rendering pipeline](0014-s05-markdown-rendering.md)                                                  | Accepted                         |
| 0015 | [S06 implementation details — content-type mapping](0015-s06-content-type-mapping.md)                                                           | Accepted (amended by validation) |
| 0016 | [S07 cache-header construction](0016-s07-cache-headers.md)                                                                                      | Accepted                         |
| 0017 | [S08 trailing-slash redirects & clean 404](0017-s08-trailing-slash-redirects.md)                                                                | Accepted                         |
| 0018 | [S09 home-mode behavior](0018-s09-home-mode.md)                                                                                                 | Accepted                         |
| 0019 | [S10 D1 pages repository — read-only surface](0019-s10-pages-repository-reads.md)                                                               | Accepted                         |
| 0020 | [S11 R2 object store adapter](0020-s11-r2-object-store.md)                                                                                      | Accepted                         |
| 0021 | [S12 entry request pipeline](0021-s12-entry-request-pipeline.md)                                                                                | Accepted                         |
| 0022 | [S13 entry-HTML edge cache integration](0022-s13-cache-integration.md)                                                                          | Accepted                         |
| 0023 | [S14 KV-backed JWKS provider](0023-s14-jwks-provider.md)                                                                                        | Accepted                         |
| 0024 | [S16 Access JWT verification](0024-s16-access-jwt-verification.md)                                                                              | Accepted                         |
| 0025 | [S15 admin API — list & detail](0025-s15-admin-api-list-detail.md)                                                                              | Accepted                         |
| 0026 | [S17 upload & publish API — multipart path convention and page kind detection](0026-s17-upload-publish-api.md)                                  | Accepted                         |
| 0027 | [S18 edit & delete API — file-delete rev bump + entry-file protection](0027-s18-edit-delete-api.md)                                             | Accepted                         |
| 0028 | [S19 admin UI — buildless HTML dashboard wired behind the Access JWT gate](0028-s19-admin-ui.md)                                                | Accepted (amended by 0045)       |
| 0029 | [S20 — setup.mjs provisioning script](0029-s20-setup-script.md)                                                                                 | Accepted                         |
| 0030 | [S21 — GitHub Actions deploy workflow and headless setup](0030-s21-github-actions-deploy.md)                                                    | Accepted                         |
| 0031 | [S22 — end-to-end smoke journey, build-size gate, and closeout findings](0031-s22-e2e-smoke-build-size-gate.md)                                 | Accepted                         |
| 0032 | [S22 follow-up — journey extended to the acceptance criteria's full leg list](0032-s22-followup-journey-legs.md)                                | Accepted                         |
| 0033 | [setup.mjs OAuth fallback auth and API error surfacing](0033-setup-oauth-fallback-auth.md)                                                      | Accepted                         |
| 0035 | [setup.mjs provisioning — team domain, covering zone, R2/D1 error mapping](0035-setup-provisioning-team-domain-zone.md)                         | Accepted                         |
| 0036 | [OQ-15 — slug auto-clean and actionable error messages (T1)](0036-oq15-slug-cleaning-and-error-messages.md)                                     | Accepted                         |
| 0038 | [OQ-17 — paste content API shape (T4)](0038-paste-content-api.md)                                                                               | Accepted                         |
| 0039 | [T3 admin UI modernization — buildless overhaul](0039-t3-admin-ui-modernization.md)                                                             | Accepted (amended by 0045)       |
| 0040 | [In-page fragment links: point the injected `<base>` at the entry file](0040-base-href-entry-file.md)                                           | Accepted                         |
| 0045 | [Admin UI CDN resource policy — pinned, judicious external resources permitted](0045-admin-ui-cdn-resource-policy.md)                           | Accepted                         |
| 0046 | [CSS design tokens — dark palette, reduced motion, transition tokens](0046-css-design-tokens-dark-palette-reduced-motion.md)                    | Accepted                         |
| 0047 | [Inline SVG Icon Sprite for Admin UI](0047-inline-svg-icon-sprite.md)                                                                           | Accepted                         |
| 0048 | [Dark mode toggle — early inline script + toggle behavior + header button](0048-dark-mode-toggle.md)                                            | Accepted                         |
| 0049 | [S6 dropzone upload UI — drag-and-drop file upload with styled dropzones](0049-dropzone-upload-ui.md)                                           | Accepted                         |
| 0051 | [Password prompt CSS polish — centered card, admin-palette matching](0051-password-prompt-css-polish.md)                                        | Accepted                         |
| 0041 | [S23 per-page password protection — visitor gate, PBKDF2 at rest, no-store protected surface](0041-s23-password-protected-pages.md)             | Accepted (amended 2026-08-02)    |
| 0042 | [S23-A implementation details — password/token primitives, unlock & asset routes, benchmark stop-and-report](0042-s23-a-password-primitives.md) | Accepted                         |
| 0043 | [S23-B implementation details — schema migration 0002, password_hash mapping, unlocks repository](0043-s23-b-schema-repositories.md)            | Accepted                         |
| 0044 | [Multi-domain collision guard in setup.mjs](0044-multi-domain-collision-guard.md)                                                               | Accepted                         |
| 0050 | [S7 edit page visual enhancements — kind icons, lock icon, kind badge icon](0050-s7-edit-page-visual-enhancements.md)                           | Accepted                         |
| 0053 | [Markdown template system — extractable templates with rich CSS, dark mode, and registry](0053-markdown-template-system.md)                     | Accepted                         |
| 0054 | [Raw markdown hosting — verbatim `source.md` pages via a new page kind](0054-raw-markdown-hosting.md)                                           | Accepted                         |

> **Numbering note:** ADR numbers are assigned sequentially, but some numbers are intentionally
> unused. 0034 was reserved for an OAuth fail-fast slice that was deferred; 0037 was reserved for
> the original T2 "delete source.md" decision, then dropped when the scope was corrected and the
> outcome was folded into an amendment of ADR 0027. Gaps document the history of scope changes.

## How to write an ADR

1. Copy the template below into `NNNN-short-title.md` (next number).
2. Fill in **Context** (what problem/decision and why now), **Decision** (what we chose, with
   evidence/citations), **Consequences** (trade-offs, what this enables or forecloses).
3. Keep it to the point; link to code and docs rather than repeating them.

```markdown
# NNNN: <title>

- Status: proposed | accepted | superseded by NNNN
- Date: <YYYY-MM-DD>

## Context

<what prompted the decision; options considered>

## Decision

<what was chosen and why; citations to official docs for platform facts>

## Consequences

<trade-offs; what this enables or forecloses>
```
