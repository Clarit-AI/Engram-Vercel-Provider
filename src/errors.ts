/**
 * Clarit-specific error types.
 */

/**
 * Thrown when a snapshot operation fails at the application layer.
 *
 * Note: Engram's /save_snapshot can fail with HTTP 200 (check `success` field),
 * while /restore_snapshot maps failures to HTTP 500. This error normalizes
 * both patterns.
 */
export class ClaritSnapshotError extends Error {
  readonly endpoint: string;
  readonly statusCode?: number;
  readonly responseBody?: unknown;

  constructor(opts: {
    message: string;
    endpoint: string;
    statusCode?: number;
    responseBody?: unknown;
  }) {
    super(opts.message);
    this.name = 'ClaritSnapshotError';
    this.endpoint = opts.endpoint;
    this.statusCode = opts.statusCode;
    this.responseBody = opts.responseBody;
  }
}

/**
 * Thrown when provider options are invalid (e.g., restoreBeforeGenerate=true
 * without continuationIds).
 */
export class ClaritValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaritValidationError';
  }
}
