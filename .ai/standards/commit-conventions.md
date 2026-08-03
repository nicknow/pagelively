# Commit conventions

We use **Conventional Commits** on feature branches. Small commits; one coherent change each;
the message explains _why_ when the diff doesn't.

## Format

```
<type>(<scope>): <short summary>

<optional body — why, not just what>
```

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `style`.

Scopes (examples): `phase0`, `roadmap`, `architecture`, `public-serving`, `admin-api`,
`markdown`, `auth`, `setup`, `docs`, `devcontainer`.

Examples:

- `chore: phase 0 repo, knowledge scaffolding and devcontainer`
- `feat(public-serving): resolve slug to page and serve entry with <base> injection`
- `test(auth): cover expired and tampered Access JWTs`

## Branching

- Feature branches per unit of work: `feat/<short-name>`, `fix/<short-name>`,
  `chore/<short-name>`, branched from `development`.
- Commit on the branch; open a PR into `development` (CI must be green). Do not force-push.
- `development` is the integration branch — it's where in-flight work lands and gets exercised
  together. `main` only moves when a human deliberately promotes `development` into it (a PR or
  merge that a human reviews and clicks), signaling "this is released/deployable." Never commit
  or merge directly to `main`.
- One slice = one branch + one (or a few, logically grouped) commits.

## Hygiene

- Stage only intended files; never commit secrets, `.env`, `.dev.vars`, `.work/` scratch, or
  `.wrangler/` state.
- A commit that touches code must not leave the suite red, typecheck failing, or lint dirty.
- Update docs in the same slice's commits (docs travel with the behavior they describe).
