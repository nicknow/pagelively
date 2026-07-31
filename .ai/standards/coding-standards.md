# Coding standards

How we write Pagelively code. The product spec is `docs/product-spec.md`; the toolchain
decisions and their rationale are the ADRs in `docs/adr/`.

## Language & runtime

- **TypeScript** on Cloudflare Workers, ES modules, module-worker format (no service-worker
  format; the test tooling requires modules).
- `strict` mode; `verbatimModuleSyntax` (type-only imports must use `import type`).
- Target `ES2022`. No Node.js APIs in Worker code unless `nodejs_compat` is deliberately added
  (avoid: keeps the bundle small, spec §15).
- The `Env` interface lives in `worker-configuration.d.ts` (regenerate with `npm run types`
  when bindings/vars change).

## Style & structure

- Small, pure, named functions; one responsibility each. Testable without a running Worker.
- No heavy frameworks in the Worker — the spec keeps the bundle small (a compact Markdown
  renderer, no frontend framework; buildless admin, spec §10, §14).
- Prefer immutable data and `const`; avoid `any` (narrow types instead).
- Comments explain _why_, not _what_; the spec's section numbers (`§12`) are useful anchors.
- Formatted by Prettier, linted by ESLint (`.prettierrc.json`, `eslint.config.mjs`). Run both
  gates before finishing a slice.

## Behavior rules that follow from the spec

- Public URLs and the R2 key layout are contracts: `pages/{id}/{rev}/{path}` (spec §8). Never
  invent a parallel layout.
- All config is read from `env` (spec §12); never hardcode domains, modes, or flags.
- The Worker must keep working when the optional KV binding is absent (spec §2, §9).

## Safety

- **Never commit secrets.** Placeholders only (`.env.example`, `.dev.vars.example`).
- Never call the live Cloudflare API or deploy from build code; tests and dev run against local
  emulation only.
- New capability ideas go to the open-questions log / roadmap, not silently into code.
