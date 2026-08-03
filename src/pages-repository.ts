/**
 * D1 pages repository — read-only surface (S10).
 *
 * Implements the `PagesRepository` contract from `docs/architecture/02-module-boundaries-contracts.md`
 * using the real migrated schema (`migrations/0001_init.sql` + `0002_password_protect.sql`).
 *
 * Query discipline:
 * - `getById`: primary-key lookup.
 * - `getBySlug`/`slugTaken`: index-covered (`idx_pages_slug`) single-condition reads.
 * - `list`: admin-only scan, `created_at DESC, id DESC` for deterministic ordering.
 *
 * Validation (`validateId` from S01, `validateSlug` from S02) runs before any SQL
 * interpolation/binding so malformed input never reaches the database.
 */

import { AppError } from "./errors";
import { validateId } from "./ids";
import { validateSlug } from "./slug";

type PageKind = "image" | "html" | "markdown" | "bundle";
type Visibility = "public" | "unlisted";

export interface PageRecord {
  id: string;
  slug: string | null;
  title: string;
  kind: PageKind;
  rev: number;
  entry_path: string;
  raw_md_path: string | null;
  show_source: 0 | 1;
  visibility: Visibility;
  // S23 (ADR 0041): "pbkdf2$<iter>$<salt-b64url>$<hash-b64url>" or null
  // (unprotected). Never serialized to API responses — surfaces as
  // `has_password: boolean` only.
  password_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewPage {
  id: string;
  slug: string | null;
  title: string;
  kind: PageKind;
  rev: number;
  entry_path: string;
  raw_md_path: string | null;
  show_source: 0 | 1;
  visibility: Visibility;
  // S23: optional on create — absent/empty = unprotected (architecture 02).
  passwordHash?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetaPatch {
  slug?: string | null;
  title?: string;
  visibility?: Visibility;
  show_source?: 0 | 1;
  // S23 tri-state: undefined = unchanged, null = clear, string = set.
  passwordHash?: string | null;
}

export interface PagesRepository {
  getById(id: string): Promise<PageRecord | null>;
  getBySlug(slug: string): Promise<PageRecord | null>;
  list(): Promise<PageRecord[]>;
  create(p: NewPage): Promise<PageRecord>;
  updateMeta(id: string, patch: MetaPatch): Promise<PageRecord | null>;
  // S23 (ADR 0041 decision 10): stored PBKDF2 string, or null to clear; no rev
  // bump; invalid id → 400 invalid_id (fail-fast); unknown id → null, no throw.
  setPasswordHash(id: string, hash: string | null): Promise<PageRecord | null>;
  applyRevBump(
    id: string,
    rev: number,
    entryPath: string,
    rawMdPath: string | null,
  ): Promise<PageRecord | null>;
  delete(id: string): Promise<boolean>;
  slugTaken(slug: string, exceptId?: string): Promise<boolean>;
  filterVisible(pages: PageRecord[]): PageRecord[];
}

/**
 * SQLite/D1 returns integers as `number` (safe for our rev values) and may
 * return `null` for nullable columns. The schema also stores booleans as `0|1`.
 * This function validates the row shape before casting to `PageRecord`.
 */
function toPageRecord(row: Record<string, unknown>): PageRecord {
  const rev = Number(row.rev);
  const show_source = Number(row.show_source) as 0 | 1;
  if (!Number.isInteger(rev) || rev < 1) {
    throw new AppError("db_read_failed", 500, "Invalid rev value from database.", { rev: row.rev });
  }
  if (show_source !== 0 && show_source !== 1) {
    throw new AppError("db_read_failed", 500, "Invalid show_source value from database.", {
      show_source: row.show_source,
    });
  }

  const visibility = row.visibility ?? "public";
  if (visibility !== "public" && visibility !== "unlisted") {
    throw new AppError("db_read_failed", 500, "Invalid visibility value from database.", {
      visibility,
    });
  }

  return {
    id: String(row.id),
    slug: row.slug === null || row.slug === undefined ? null : String(row.slug),
    title: String(row.title ?? ""),
    kind: String(row.kind) as PageKind,
    rev,
    entry_path: String(row.entry_path),
    raw_md_path:
      row.raw_md_path === null || row.raw_md_path === undefined ? null : String(row.raw_md_path),
    show_source,
    visibility: visibility as Visibility,
    password_hash:
      row.password_hash === null || row.password_hash === undefined
        ? null
        : String(row.password_hash),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function assertValidId(id: string): void {
  if (!validateId(id)) {
    throw new AppError("invalid_id", 400, "Invalid page id.");
  }
}

function assertValidSlug(slug: string): void {
  const result = validateSlug(slug);
  if (!result.ok) {
    throw result.error;
  }
}

function wrapDbError(error: unknown): AppError {
  const message = error instanceof Error ? error.message : "Unexpected database error";
  return new AppError("db_read_failed", 500, "Database read failed.", message);
}

function wrapDbWriteError(error: unknown): AppError {
  const message = error instanceof Error ? error.message : "Unexpected database error";
  return new AppError("db_write_failed", 500, "Database write failed.", message);
}

export function createPagesRepository(db: D1Database): PagesRepository {
  return {
    async getById(id: string): Promise<PageRecord | null> {
      assertValidId(id);
      try {
        const row = await db
          .prepare(
            `SELECT id, slug, title, kind, rev, entry_path, raw_md_path, show_source, visibility, password_hash, created_at, updated_at
             FROM pages
             WHERE id = ?`,
          )
          .bind(id)
          .first<Record<string, unknown>>();
        return row ? toPageRecord(row) : null;
      } catch (error) {
        throw wrapDbError(error);
      }
    },

    async getBySlug(slug: string): Promise<PageRecord | null> {
      assertValidSlug(slug);
      try {
        const row = await db
          .prepare(
            `SELECT id, slug, title, kind, rev, entry_path, raw_md_path, show_source, visibility, password_hash, created_at, updated_at
             FROM pages
             WHERE slug = ?`,
          )
          .bind(slug)
          .first<Record<string, unknown>>();
        return row ? toPageRecord(row) : null;
      } catch (error) {
        throw wrapDbError(error);
      }
    },

    async list(): Promise<PageRecord[]> {
      try {
        const result = await db
          .prepare(
            `SELECT id, slug, title, kind, rev, entry_path, raw_md_path, show_source, visibility, password_hash, created_at, updated_at
             FROM pages
             ORDER BY created_at DESC, id DESC`,
          )
          .all<Record<string, unknown>>();
        return result.results.map(toPageRecord);
      } catch (error) {
        throw wrapDbError(error);
      }
    },

    async slugTaken(slug: string, exceptId?: string): Promise<boolean> {
      assertValidSlug(slug);
      if (exceptId !== undefined) {
        assertValidId(exceptId);
      }
      try {
        const query =
          exceptId === undefined
            ? db.prepare("SELECT 1 FROM pages WHERE slug = ? LIMIT 1").bind(slug)
            : db
                .prepare("SELECT 1 FROM pages WHERE slug = ? AND id != ? LIMIT 1")
                .bind(slug, exceptId);
        const row = await query.first<Record<string, unknown>>();
        return row !== null;
      } catch (error) {
        throw wrapDbError(error);
      }
    },

    async create(p: NewPage): Promise<PageRecord> {
      try {
        await db
          .prepare(
            `INSERT INTO pages (id, slug, title, kind, rev, entry_path, raw_md_path, show_source, visibility, password_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            p.id,
            p.slug,
            p.title,
            p.kind,
            p.rev,
            p.entry_path,
            p.raw_md_path,
            p.show_source,
            p.visibility,
            p.passwordHash ?? null,
            p.created_at,
            p.updated_at,
          )
          .run();
        const { passwordHash, ...rest } = p;
        return { ...rest, password_hash: passwordHash ?? null };
      } catch (error) {
        throw wrapDbWriteError(error);
      }
    },

    async updateMeta(id: string, patch: MetaPatch): Promise<PageRecord | null> {
      assertValidId(id);
      const setClauses: string[] = [];
      const values: (string | number | null)[] = [];

      if ("slug" in patch) {
        if (typeof patch.slug === "string") {
          assertValidSlug(patch.slug);
        }
        setClauses.push("slug = ?");
        values.push(patch.slug === undefined || patch.slug === null ? null : patch.slug);
      }
      if ("title" in patch) {
        setClauses.push("title = ?");
        values.push(patch.title ?? "");
      }
      if ("visibility" in patch) {
        if (patch.visibility !== "public" && patch.visibility !== "unlisted") {
          throw new AppError(
            "invalid_visibility",
            400,
            "Visibility must be 'public' or 'unlisted'.",
          );
        }
        setClauses.push("visibility = ?");
        values.push(patch.visibility);
      }
      if ("show_source" in patch) {
        if (patch.show_source !== 0 && patch.show_source !== 1) {
          throw new AppError("invalid_show_source", 400, "show_source must be 0 or 1.");
        }
        setClauses.push("show_source = ?");
        values.push(patch.show_source);
      }
      // S23 tri-state (architecture 02): undefined/absent = unchanged,
      // null = clear, string = set. No rev bump — a metadata edit like the
      // others (ADR 0012: RevAction "password-edit").
      if ("passwordHash" in patch && patch.passwordHash !== undefined) {
        setClauses.push("password_hash = ?");
        values.push(patch.passwordHash);
      }

      if (setClauses.length === 0) {
        // Nothing to change; return current row if it exists.
        return this.getById(id);
      }

      setClauses.push("updated_at = ?");
      values.push(new Date().toISOString());
      values.push(id);

      try {
        const result = await db
          .prepare(
            `UPDATE pages
             SET ${setClauses.join(", ")}
             WHERE id = ?
             RETURNING id, slug, title, kind, rev, entry_path, raw_md_path, show_source, visibility, password_hash, created_at, updated_at`,
          )
          .bind(...values)
          .first<Record<string, unknown>>();
        return result ? toPageRecord(result) : null;
      } catch (error) {
        throw wrapDbWriteError(error);
      }
    },

    // S23 (ADR 0041 decision 10): dedicated set/clear for the unlock handlers.
    // Shares ONE implementation with `updateMeta` — it delegates the tri-state
    // UPDATE, so both paths write the same column, bump `updated_at`, never
    // touch `rev`, fail fast on invalid ids (400 invalid_id), and return null
    // for unknown ids without throwing.
    async setPasswordHash(id: string, hash: string | null): Promise<PageRecord | null> {
      return this.updateMeta(id, { passwordHash: hash });
    },

    async applyRevBump(
      id: string,
      rev: number,
      entryPath: string,
      rawMdPath: string | null,
    ): Promise<PageRecord | null> {
      assertValidId(id);
      try {
        const result = await db
          .prepare(
            `UPDATE pages
             SET rev = ?, entry_path = ?, raw_md_path = ?, updated_at = ?
             WHERE id = ?
             RETURNING id, slug, title, kind, rev, entry_path, raw_md_path, show_source, visibility, password_hash, created_at, updated_at`,
          )
          .bind(rev, entryPath, rawMdPath, new Date().toISOString(), id)
          .first<Record<string, unknown>>();
        return result ? toPageRecord(result) : null;
      } catch (error) {
        throw wrapDbWriteError(error);
      }
    },

    async delete(id: string): Promise<boolean> {
      assertValidId(id);
      try {
        const result = await db.prepare("DELETE FROM pages WHERE id = ?").bind(id).run();
        return result.meta.changes > 0;
      } catch (error) {
        throw wrapDbWriteError(error);
      }
    },

    filterVisible(pages: PageRecord[]): PageRecord[] {
      return pages.filter(
        (page) =>
          page.visibility === "public" || page.visibility === null || page.visibility === undefined,
      );
    },
  };
}
