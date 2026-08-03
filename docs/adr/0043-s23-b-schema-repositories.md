# 0043: S23-B implementation details — schema migration 0002, password_hash mapping, unlocks repository

- Status: accepted
- Date: 2026-08-03

## Context

S23-B implements the storage layer of the per-page password feature: the `0002`
migration, the `password_hash` column on `PageRecord`, and the new
`UnlocksRepository` (ADR 0041 decisions 1 and 10; architecture 02/03). The
feature decisions are locked in ADR 0041; S23-A (pure primitives) is recorded
in ADR 0042. This record captures the slice-level shapes and the resolutions
the slice was required to make explicit.

## Decision

1. **`migrations/0002_password_protect.sql` — exactly as specified (ADR 0041
   decision 10).** `ALTER TABLE pages ADD COLUMN password_hash TEXT;` (nullable —
   existing rows become NULL) plus `CREATE TABLE page_unlocks (page_id TEXT
PRIMARY KEY, token_hash TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY
(page_id) REFERENCES pages(id) ON DELETE CASCADE);`. The existing migration
   runner (`readD1Migrations` + `applyD1Migrations`, vitest.config.mts) applies
   it to every test DB automatically — no config change. `db:local:migrate`
   applies it to the local emulated D1 in the same way (verified 2026-08-03).

2. **`setPasswordHash` and `updateMeta` share ONE implementation.** The
   architecture contract specifies both `MetaPatch.passwordHash?: string | null`
   (tri-state) and a dedicated `PagesRepository.setPasswordHash(id, hash | null)`.
   Resolved as recommended: `updateMeta` owns the tri-state UPDATE
   (`"passwordHash" in patch` guard; `undefined`/absent = unchanged, `null` =
   clear, string = set); `setPasswordHash(id, hash)` **delegates to
   `updateMeta(id, { passwordHash: hash })`** and is the dedicated set/clear used
   by the S23 handlers. Consequences, all covered by tests: both paths write the
   same column, bump `updated_at` (a metadata edit like any other), never touch
   `rev` (RevAction `password-edit`, ADR 0012), fail fast on invalid ids (400
   `invalid_id` before SQL), and return `null` for unknown ids without throwing.

3. **`NewPage.passwordHash` is optional (`passwordHash?: string | null`).** The
   contract comment says "password_hash is optional on create (absent/empty =
   unprotected)"; the type is written `passwordHash?: string | null` so the
   current `admin-api.ts` `NewPage` literal (S23-D will extend it) keeps
   compiling without a forced, untested change. `create` stores
   `passwordHash ?? null` and returns the `PageRecord` with the mapped
   `password_hash` (never a raw `passwordHash` key on the record).

4. **`UnlocksRepository` upsert semantics (ADR 0041 decision 1).**
   `create(pageId, tokenHash)` is `INSERT … ON CONFLICT(page_id) DO UPDATE SET
token_hash = excluded.token_hash, created_at = excluded.created_at` — the
   **latest unlock wins**, including the timestamp; re-unlocking rotates the
   token and invalidates the previous cookie. `getByPageId` is the only read
   (a PK lookup — no extra indexes, D1 free-tier reads). `deleteByPageId` is the
   explicit revocation call on password set/clear; page delete removes the row
   via the FK cascade (verified against the emulated D1 with the same approach
   as the existing `files` cascade test — no PRAGMA setup needed; FK enforcement
   is on in the emulation, proven by `ON DELETE CASCADE` firing).

5. **Error mapping follows the existing repository discipline.** All three
   unlocks methods validate `page_id` first (400 `invalid_id`); D1 read
   failures → `db_read_failed`/500, write failures → `db_write_failed`/500
   (including a `create` for a nonexistent page, which trips the FK constraint —
   a caller bug, 500, never 400). `token_hash` is trusted as the
   handler-supplied hex SHA-256 (ADR 0041 decision 1); the repository stores it
   as-is, and the regression test asserts no test-DB row contains a raw token.

6. **Raw tokens are never stored (ADR 0041 decision 1) — tested at the schema
   level.** `PRAGMA table_info(page_unlocks)` is asserted to be exactly
   `page_id | token_hash | created_at` (PK on `page_id`, NOT NULL on
   `token_hash`/`created_at`); the only token-related column is `token_hash`;
   every stored value matches `/^[0-9a-f]{64}$/`; a known raw token string never
   appears in any row value.

## Consequences

- Protected page views stay one D1 PK read (`getByPageId`) + one SHA-256 + one
  constant-time compare — no PBKDF2 on the view path (ADR 0041).
- Password revocation is two writes: `setPasswordHash` (set or clear) + the
  handler's `unlocks.deleteByPageId(id)` (S23-D wires the call) — existing
  cookies stop working immediately.
- `updateMeta`'s RETURNING now includes `password_hash`, so every existing
  select/return path maps the new column (`getBySlug`/`getById`/`list`/
  `create`/`updateMeta`/`applyRevBump`); `delete` selects nothing and is
  unchanged. Full regression suite green (1318 tests — 1306 implementer + 12 validator
  probes).

## Cross-references

- ADR 0041 (decisions 1, 10; scope), ADR 0042 (S23-A primitives),
  ADR 0012 (RevAction `password-edit`), ADR 0006 (rev policy).
- Docs: `docs/architecture/02-module-boundaries-contracts.md` (repository
  contracts; `NewPage.passwordHash?` precision edit),
  `docs/architecture/03-data-model.md` (0002 schema semantics).
- Scratch: `.work/implementer/s23-b-notes.md`.
