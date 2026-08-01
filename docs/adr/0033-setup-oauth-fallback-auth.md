# 0033: setup.mjs OAuth fallback auth and API error surfacing

- Status: accepted
- Date: 2026-08-01

## Context

`setup.mjs` (ADR 0029, item 7) supports two auth paths: a `CLOUDFLARE_API_TOKEN` from the
environment, or interactive `wrangler login`. In the interactive path the script ran
`wrangler login`, but the `api()` closure only ever attached `Authorization: Bearer` when
`env.CLOUDFLARE_API_TOKEN` was set. With no env token, every Cloudflare REST call went out
**unauthenticated** — `GET /accounts/{account_id}/access/apps` returned HTTP 400 and the
script failed with `Failed to list Access apps: 400`. The OAuth credentials `wrangler login`
had just stored were never read.

On top of that, API failures only surfaced the HTTP status (`Failed to list Access apps:
400`), discarding the Cloudflare `errors[]` body that explains _why_ (e.g. code `10000`
"Authentication error" vs. code `1047` "Zero Trust not enabled").

Two platform facts drive the fix (verified against the installed wrangler v4.116.0 bundle and
the `xdg-portable`/`xdg-app-paths` sources):

- By default Wrangler stores the OAuth access/refresh tokens from `wrangler login` in a
  **plaintext TOML file** under the global config directory — readable by any process on the
  machine. The directory resolves as `xdgAppPaths(".wrangler").config()` per `xdg-portable`'s
  `XDG.config()` (`XDG_CONFIG_HOME` wins on every OS when set):
  - Linux: `~/.config/.wrangler/config/default.toml`
  - macOS: `~/Library/Preferences/.wrangler/config/default.toml`
  - Windows: `%APPDATA%\xdg.config\.wrangler\config\default.toml` (`%APPDATA%` falls back to
    `~\AppData\Roaming`)
  - A legacy `~/.wrangler` dir override (checked before the XDG dir) is still honored by
    wrangler for backwards compatibility, so `~/.wrangler/config/default.toml` remains a
    candidate on every OS.
  - `WRANGLER_HOME` is **not** a wrangler environment variable (0 occurrences in the v4.116
    bundle) and is not honored.
- `wrangler login --use-keyring` opts into an **encrypted** `default.enc` (AES-256-GCM) with
  the 32-byte key in the OS keychain; opting in deletes the plaintext file, and the choice is
  persisted across invocations. Wrangler itself reads the keychain; a plain Node script cannot.

## Decision

1. **Read the plaintext OAuth token for API calls.** `setup.mjs` gains pure, exported helpers
   that locate and parse wrangler's global config:
   - `wranglerConfigPaths(env, osInfo)` — candidate `config/default.toml` paths in order,
     deduplicated: `$XDG_CONFIG_HOME/.wrangler/config/default.toml` if `XDG_CONFIG_HOME` is
     set, then the platform-native path
     (Linux `~/.config/.wrangler/config/default.toml`; macOS
     `~/Library/Preferences/.wrangler/config/default.toml`; Windows
     `%APPDATA%\xdg.config\.wrangler\config\default.toml` with `%APPDATA%` falling back to
     `~\AppData\Roaming`), then the legacy `~/.wrangler/config/default.toml` on every OS.
     `WRANGLER_HOME` is intentionally absent — it is not a wrangler variable.
   - `parseOauthToken(tomlContent)` — extracts a double-quoted `oauth_token = "..."` value,
     else `undefined`.
   - `resolveWranglerAuthToken(paths, readFile)` — first readable path containing a token,
     skipping `ENOENT` (other read errors propagate), else `{ token: undefined, path: undefined }`.
   - `findEncryptedWranglerConfig(paths, stat)` — first existing `default.enc` next to a
     candidate `default.toml`, else `undefined`.
   - `os` values are **injected** (`homedir`, `platform`) rather than imported at module
     scope: the Workers-pool test environment (workerd) cannot load `node:os`, so the pure
     helpers stay testable in the pool while `buildRealDeps` supplies the real values from a
     dynamic `import("node:os")`.

2. **`api()` falls back to the OAuth token.** A new exported `createApiClient({ env,
oauthToken, resolveOauthToken, fetchImpl })` attaches `Authorization: Bearer <token>` from,
   in order: the env token, an up-front OAuth token, a lazily-resolved OAuth token (so a
   token written by `wrangler login` _during_ the run is picked up on the first API call),
   otherwise it throws a clear error naming `CLOUDFLARE_API_TOKEN` / `wrangler login` without
   making the request.

3. **Fail fast on keyring-encrypted credentials.** When no plaintext token is found but a
   `default.enc` exists, the script throws an actionable error: re-run `wrangler login
--no-use-keyring` to store the token as plaintext, or set `CLOUDFLARE_API_TOKEN`. It does
   not attempt to decrypt the keychain.

4. **Surface the API `errors[]` body.** New `describeApiError(response, fallback)` returns
   `"<fallback> (HTTP <status>): [<code>] <message>[, ...]"`, reading `errors[].code` and
   `errors[].message`, tolerating an unreadable/already-consumed body. Applied to the Access
   apps list, Access app create, Access app get, and Access policy list/create failures.

5. **Behavior preserved.** The Zero Trust not-initialized pause path (error codes `1000` /
   `1047` or "access not enabled"/"zero trust" messages) is untouched, and headless mode still
   throws before any API call when no `CLOUDFLARE_API_TOKEN` is set. The API token remains the
   authoritative path (product spec §13 — Access admin via a scoped token in CI).

## Citations

- Wrangler credential storage: `developers.cloudflare.com/workers/wrangler/commands/general/#storing-oauth-credentials-in-the-os-keychain` — default plaintext `~/.config/.wrangler/config/default.toml`; `--use-keyring` writes encrypted `default.enc` + OS-keychain key and deletes the plaintext file; `--no-use-keyring` opts out; API tokens take priority over OAuth credentials (verified via `cfdocs`).
- Wrangler `login` options (`--use-keyring` / `--no-use-keyring`, persisted choice): same page, `login` section (verified via `cfdocs`).
- `CLOUDFLARE_AUTH_USE_KEYRING` per-process override: `developers.cloudflare.com/workers/wrangler/system-environment-variables/` (verified via `cfdocs`).
- ADR 0029 `setup.mjs` provisioning script — auth design this ADR amends (item 7).

## Consequences

- Interactive `npm run setup` now authenticates REST calls with the OAuth token `wrangler
login` stores, fixing the `Failed to list Access apps: 400` failure.
- Users who opted into `--use-keyring` get a clear, actionable error instead of a confusing
  HTTP 400; nothing is silently downgraded.
- Error messages now include the Cloudflare `errors[].code/message`, making auth failures
  (code `10000`) distinguishable from Zero Trust-not-initialized (code `1047`).
- `setup.d.mts` gains declarations for the new exports so typechecking covers them.
- The injected-`os` seam is a small API surface cost, paid so the pure helpers remain
  testable in the Workers pool without crashing workerd.
