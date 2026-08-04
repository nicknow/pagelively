# Pagelively

A single-user, Cloudflare-hosted **static content publisher**: upload HTML files, Markdown
files, and images (individually, as folders, or pasted directly) and serve them publicly by a
short **id** or a friendly **slug** — free on Cloudflare's free tiers.

You deploy Pagelively into your own Cloudflare account. There's no signup, no hosted service,
no third party involved — you own the account, the domain, and the data.

- Asset bytes (images, CSS, JS, fonts) are served straight from an R2 custom domain: cached at
  the edge, free, and unlimited.
- The Worker is only in the path for the entry document (the actual page load) — the thing that
  keeps this free even if a page gets popular.
- Admin access is protected by Cloudflare Access — no passwords or accounts to manage in the
  app itself.

## Why Pagelively Exists

This was entirely to meet my own want. I already have a [blog at nicknow.net](https://nicknow.net) but I also have times where I just want to serve some content. This was always true and has become even more so over the last year or two when I often ask AI to generate a Markdown document or HTML file. Sharing either of those formats via email, text, or Slack/Teams/GChat has it's own problems. You can share the chat but that often doesn't make sense and also has its own problems. These are content documents and they should be easy to share online.

As I said, I have my blog. But not all of this content is stuff I want to post to my blog. A research project that a handful of people need to see doesn't belong on the blog. Also, my blog is a Github repo and hosted on Cloudflare Pages, so while it's not that difficult to post it also isn't copy/paste simple.

The workflow that I really wanted to satisfy was: I'm on my computer or phone working on problem with AI bots and eventually get to a completed document. I wanted to be able to ask AI to put everything together into a single page HTML file or a Markdown document. And, then, I wanted to be able to quickly publish that and have a URL I could share. I didn't want to pay anyone and I didn't want to manage anything and I didn't want a service that wanted to control my content and I wanted it repeatable so I could have multiple domains hosting pages this way.

My first inclination was to simply build a poster/editor tool that would write to a Github repo. Then I could connect the Github repo to Cloudflare Pages and let a workflow handle the publishing. I still like that idea and may go back and work on it in the future. **But**, that would mean having to wait for a publish cycle to complete each time _and_ it would mean setting up both a Github repo and hosting on Cloudflare.

Pagelively is the answer to my requirements. I don't think it's perfect. I can't guarantee it'll work for everyone. But it meets my requirements and has made it relatively easy for me to setup this service on multiple domains (you can setup as many instances as you want on a single domain so long as each has it's own subdomain. See [Deploying to multiple domains](docs/operations/README.md#deploying-to-multiple-domains) for instructions.)

### Building Pagelively

While I wanted this to exist a big motivation was to build a publicly released repo entirely using AI-Driven development. As of this release the only things I've written are these sections in the README.MD and a few edits to some of the other documentation. I worked with Claude to refine my idea and build a product specification. Claude also helped define the agents which are in `.ai\prompts`. I used Opencode for all development and testing mostly w/ Big Pickle (because it was Free) and then Kimi 2.7 Code (when I used my limits on Big Pickle and didn't want to wait.) I had Claude help troubleshoot a couple times, which I wanted to challenge what I was being told. Finally, I had Claude do a full clean-up/update on the documentation.

## Features

- **Upload anything static**: single files, whole folders (preserving relative paths), or
  paste HTML/Markdown directly.
- **Markdown, rendered**: uploads render to HTML on publish, with the original source
  optionally downloadable.
- **Two URLs per page**: a permanent id-based URL and an editable, friendly slug.
- **A real (if minimal) admin UI**: dashboard, drag-and-drop-style upload, metadata editing,
  file add/replace/delete — no build step, no framework.
- **One-command deploy**: `npm run setup` provisions everything (R2, D1, Access, custom
  domains) and deploys, idempotently.
- **Free-tier by design**: public asset bandwidth is free and unlimited; the only metered
  request is the page load itself.

## Using Pagelively

Once it's deployed, day-to-day use — signing in, publishing your first page, understanding ids
vs. slugs, editing and deleting content, troubleshooting upload errors — is covered in the
**[user guide](docs/guide/README.md)**. Start there if you just want to use the app.

## Deploying your own instance

**Prerequisite: Node.js 22 or newer** on Linux, macOS, or Windows 10/11 (Wrangler and
`setup.mjs` both need it — no WSL required).

1. **Cloudflare prerequisites**: an account, your target domain added as a zone, an R2 plan, and Zero
   Trust initialized (a one-time step — see [`docs/operations/`](docs/operations/README.md)).
2. Create a Cloudflare API token with the scopes listed in
   [`docs/operations/README.md`](docs/operations/README.md#api-token-scopes) — that's the
   authoritative list; copy it from there. **This token is required.** Interactive
   `wrangler login` with no token does not work for this app — confirmed by testing — because
   setup provisions your Cloudflare Access application through the API, and Wrangler's OAuth
   login is never granted an Access/Zero Trust scope. See
   [Token vs interactive auth](docs/operations/README.md#token-vs-interactive-auth) for the
   full explanation.
3. Clone this repo, then:
   ```bash
   npm install
   export CLOUDFLARE_API_TOKEN="your-token"
   npm run setup
   ```
   `setup.mjs` idempotently provisions the R2 bucket, D1 database, optional KV namespace,
   Cloudflare Access application/policy, and both custom domains, then deploys. Re-running it
   is always safe.
4. Visit the live URL, admin URL, and CDN URL printed by the script, then work through the
   [operator smoke-test checklist](docs/operations/smoke-test-checklist.md).

### Deploying via GitHub Actions

Prefer not to run `setup.mjs` locally? Fork or push this repo to GitHub, add three repo
secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ADMIN_EMAILS`), and run
**Actions → "Deploy Pagelively to Cloudflare" → Run workflow**. It runs the same `setup.mjs`
headlessly, using your inputs and secrets. The workflow only ever runs on manual dispatch —
never on push or pull request — so deploying stays a deliberate human action.

Full details, including the exact token scopes and the workflow's inputs: see
[`docs/operations/README.md`](docs/operations/README.md).

## Local development

No Cloudflare account is needed to build or test Pagelively — everything runs against local
emulation (D1, R2, and KV are emulated by Wrangler's Miniflare/workerd).

```bash
npm install
npm run dev    # local Worker at http://localhost:8787
npm test       # full suite, local emulation only
```

See [`docs/development/README.md`](docs/development/README.md) for the devcontainer setup and
the full local loop, and [`CONTRIBUTING.md`](CONTRIBUTING.md) if you're planning to send a
pull request.

## Documentation

| Doc                                         | Covers                                                    |
| ------------------------------------------- | --------------------------------------------------------- |
| [**User guide**](docs/guide/README.md)      | Using a deployed instance day to day.                     |
| [Operations](docs/operations/README.md)     | Provisioning, deploying, and running Pagelively for real. |
| [Product spec](docs/product-spec.md)        | What Pagelively is and why it's built this way.           |
| [API reference](docs/api/README.md)         | The admin API and admin UI contracts.                     |
| [Architecture](docs/architecture/README.md) | How the pieces fit together internally.                   |
| [Development](docs/development/README.md)   | Local build/test loop.                                    |
| [Decision log](docs/adr/README.md)          | Every significant design decision, with rationale.        |

The full index, including a short glossary of recurring terms, is at
[`docs/README.md`](docs/README.md).

## Status

**v1.0.0 released.** The full publish/edit/delete flow, the admin UI, Cloudflare Access auth,
and one-command provisioning are all implemented and covered by an automated local
end-to-end test in addition to the unit suite. Run `npm test` for current results — it
includes a gate that fails the build if the Worker bundle grows past the Workers free-tier
size limit (see [`test/build-size.test.ts`](test/build-size.test.ts)).

## Contributing

Bug reports, feature requests, and pull requests are welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md). For security issues, see [`SECURITY.md`](SECURITY.md)
instead of opening a public issue.

This project was originally built through an AI-agent-driven development process; see
[`AGENTS.md`](AGENTS.md) and [`.ai/`](.ai/) if you're curious how that worked or want an AI
coding agent to work effectively in this repo. It's not required reading to use or contribute
to Pagelively by hand.

## License

[MIT](LICENSE)
