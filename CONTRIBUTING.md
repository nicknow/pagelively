# Contributing to Pagelively

Thanks for considering a contribution. Pagelively is a small, single-purpose tool, so the bar
is: keep it small, keep it tested, keep it working without a Cloudflare account for anyone
running the test suite.

## Getting set up

Everything you need for local development — devcontainer, running the app, running the test
suite — is in [`docs/development/README.md`](docs/development/README.md). Short version:

```bash
npm install
npm run dev    # local Worker at http://localhost:8787, no Cloudflare account needed
npm test       # full suite, runs against local emulation (workerd + Miniflare)
```

No Cloudflare credentials are ever required for development or testing. Provisioning and
deploying a real instance is a separate, human-run step covered in
[`docs/operations/`](docs/operations/) — contributors don't need it to work on the code.

## Before opening a pull request

Run the full gate locally:

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
```

A PR that leaves any of these red won't be merged. If you're changing behavior, add or update
tests first — see [`.ai/standards/test-standards.md`](.ai/standards/test-standards.md) for how
this project tests (real D1 migrations against local emulation, mocked JWKS for Access, no
faked infrastructure).

For code style and structural conventions, see
[`.ai/standards/coding-standards.md`](.ai/standards/coding-standards.md).

## Commit messages

This project uses [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

<optional body — why, not just what>
```

Types: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `style`.
Keep commits small and coherent — one change per commit. Full conventions, including branch
naming, in [`.ai/standards/commit-conventions.md`](.ai/standards/commit-conventions.md).

## Documentation travels with behavior

If a change affects what's documented in `docs/` (the API, the admin UI, the setup flow,
architecture, or a recorded decision), update the relevant doc in the same PR. Significant
design decisions get an [ADR](docs/adr/) — see `docs/adr/README.md` for the template.

## Reporting bugs / requesting features

Open a GitHub issue. For anything security-related, see [`SECURITY.md`](SECURITY.md) instead
of filing a public issue.

## A note on how this project is built

Pagelively's history includes both AI-agent-driven development and direct human contribution —
see [`AGENTS.md`](AGENTS.md) and [`.ai/`](.ai/) if you're curious how that process works or
want an AI coding agent to work in this repo effectively. You don't need to read any of that to
contribute by hand; the sections above are the parts that apply to every contributor.

## License

By contributing, you agree your contributions are licensed under the project's
[MIT license](LICENSE).
