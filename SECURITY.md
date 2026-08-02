# Security Policy

Pagelively is a self-hosted, single-operator application: you deploy it into your own
Cloudflare account, and it's designed so that only you (or the email addresses you configure)
can reach the admin surface. That said, it does handle authentication (Cloudflare Access JWT
verification), file uploads, and public content serving, so security issues are taken
seriously.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Instead, report it privately by emailing **pagelively.security@nicknow.net** with:

- A description of the issue and its potential impact.
- Steps to reproduce (a minimal example, if possible).
- Any relevant version/commit information.

You should get an acknowledgment within a few days. Once a fix is available, we'll coordinate
on disclosure timing — a fix and a note in the changelog is the usual outcome for a project
this size.

## Scope

In scope:

- The Worker code in `src/` — request handling, auth verification, upload/publish pipeline,
  admin API and UI.
- `setup.mjs` and the provisioning flow.

Generally out of scope:

- Vulnerabilities in Cloudflare's own platform (Workers, R2, D1, Access) — report those to
  Cloudflare directly.
- Issues that require an attacker to already have valid Cloudflare Access credentials for your
  deployment (that's the trust boundary Access is meant to enforce) — unless the report is
  specifically about the Worker's own JWT verification (`src/access-verify.ts`) failing open.
- Denial of service against a misconfigured deployment (e.g., a deliberately public admin
  route) rather than the application's default behavior.

## Supported versions

This project doesn't yet maintain multiple release branches; security fixes are made against
the latest commit on `main`. If you're running an older deployment, redeploying from the
current `main` after `git pull` is the supported way to pick up a fix.
