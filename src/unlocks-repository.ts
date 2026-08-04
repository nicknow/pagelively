/**
 * D1 page_unlocks repository (S23, ADR 0041 decision 1).
 *
 * Implements the `UnlocksRepository` contract from
 * `docs/architecture/02-module-boundaries-contracts.md` using the real migrated
 * schema (`migrations/0002_password_protect.sql`).
 *
 * One row per protected page. `create` is an upsert — the latest unlock wins,
 * re-unlocking rotates the token and invalidates the previous cookie. Only the
 * hex SHA-256 of the opaque cookie token (`token_hash`) is ever stored; the raw
 * token is never stored or logged (ADR 0041 decision 1).
 *
 * Query discipline: every read is a primary-key lookup by `page_id` — a
 * protected page view costs exactly one D1 PK read (index-covered; D1 free-tier
 * 5 M rows/day constraint). Validation (`validateId` from S01/ADR 0010) runs
 * before any SQL so malformed input never reaches the database.
 */

import { AppError } from "./errors";
import { validateId } from "./ids";

export interface UnlockRecord {
  tokenHash: string;
  createdAt: string;
}

export interface UnlocksRepository {
  /** Upsert (INSERT … ON CONFLICT): latest unlock wins, one row per page. */
  create(pageId: string, tokenHash: string): Promise<void>;
  /** PK lookup by page_id; null when the page has no unlock row. */
  getByPageId(pageId: string): Promise<UnlockRecord | null>;
  /** Called on password set/clear (revocation); page delete cascades. */
  deleteByPageId(pageId: string): Promise<void>;
}

function assertValidId(id: string): void {
  if (!validateId(id)) {
    throw new AppError("invalid_id", 400, "Invalid page id.");
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

export function createUnlocksRepository(db: D1Database): UnlocksRepository {
  return {
    async create(pageId: string, tokenHash: string): Promise<void> {
      assertValidId(pageId);
      try {
        await db
          .prepare(
            `INSERT INTO page_unlocks (page_id, token_hash, created_at)
             VALUES (?, ?, ?)
             ON CONFLICT(page_id) DO UPDATE SET
               token_hash = excluded.token_hash,
               created_at = excluded.created_at`,
          )
          .bind(pageId, tokenHash, new Date().toISOString())
          .run();
      } catch (error) {
        throw wrapDbWriteError(error);
      }
    },

    async getByPageId(pageId: string): Promise<UnlockRecord | null> {
      assertValidId(pageId);
      try {
        const row = await db
          .prepare(
            `SELECT page_id, token_hash, created_at
             FROM page_unlocks
             WHERE page_id = ?`,
          )
          .bind(pageId)
          .first<Record<string, unknown>>();
        if (!row) {
          return null;
        }
        return {
          tokenHash: String(row.token_hash),
          createdAt: String(row.created_at),
        };
      } catch (error) {
        throw wrapDbError(error);
      }
    },

    async deleteByPageId(pageId: string): Promise<void> {
      assertValidId(pageId);
      try {
        await db.prepare("DELETE FROM page_unlocks WHERE page_id = ?").bind(pageId).run();
      } catch (error) {
        throw wrapDbWriteError(error);
      }
    },
  };
}
