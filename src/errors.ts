/**
 * AppError — the shared error taxonomy (architecture 05, ADR 0005). Created
 * minimally in S01 because slugify's empty-result failure is specified as an
 * "AppError-style typed failure" (ADR 0007). The response boundary
 * (toErrorResponse) lands with the error boundary in S12.
 */

export type ErrorStatus = 400 | 403 | 404 | 409 | 413 | 422 | 500;

export class AppError extends Error {
  readonly code: string; // stable snake_case, e.g. "invalid_slug"
  readonly status: ErrorStatus;
  readonly publicMessage: string;
  readonly detail?: unknown; // internal only — logged, never sent to clients

  constructor(code: string, status: ErrorStatus, publicMessage: string, detail?: unknown) {
    super(publicMessage);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
    if (detail !== undefined) {
      this.detail = detail;
    }
  }
}
