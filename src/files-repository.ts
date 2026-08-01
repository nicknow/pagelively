/**
 * D1 files repository — read-only surface (S15).
 *
 * Implements the read-only part of the `FilesRepository` contract from
 * `docs/architecture/02-module-boundaries-contracts.md` using the real migrated
 * schema (`migrations/0001_init.sql`).
 *
 * Validation (`validateId` from S01/ADR 0010) runs before any SQL so malformed
 * input never reaches the database. Only `listForPage` is implemented in this
 * slice; write methods land in S18.
 */

import { AppError } from "./errors";
import { validateId } from "./ids";

export interface FileRecord {
  page_id: string;
  path: string;
  r2_key: string;
  content_type: string;
  size: number;
}

export interface FilesRepository {
  listForPage(pageId: string): Promise<FileRecord[]>;
}

function toFileRecord(row: Record<string, unknown>): FileRecord {
  const size = Number(row.size);
  if (!Number.isInteger(size) || size < 0) {
    throw new AppError("db_read_failed", 500, "Invalid size value from database.", {
      size: row.size,
    });
  }

  return {
    page_id: String(row.page_id),
    path: String(row.path),
    r2_key: String(row.r2_key),
    content_type: String(row.content_type),
    size,
  };
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

export function createFilesRepository(db: D1Database): FilesRepository {
  return {
    async listForPage(pageId: string): Promise<FileRecord[]> {
      assertValidId(pageId);
      try {
        const result = await db
          .prepare(
            `SELECT page_id, path, r2_key, content_type, size
             FROM files
             WHERE page_id = ?
             ORDER BY path ASC`,
          )
          .bind(pageId)
          .all<Record<string, unknown>>();
        return result.results.map(toFileRecord);
      } catch (error) {
        throw wrapDbError(error);
      }
    },
  };
}
