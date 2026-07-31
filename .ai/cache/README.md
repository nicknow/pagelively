# cache/

Local caches for agent tooling (e.g. documentation fetches, dependency metadata).

- **Git-ignored.** Never commit cached content; it is reproducible and must not become a
  dependency.
- Anything a future developer or agent would benefit from is promoted to `docs/` / `.ai/`
  instead of being cached here.
