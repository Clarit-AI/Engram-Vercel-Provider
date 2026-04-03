/**
 * Low-level HTTP client for Engram snapshot endpoints.
 *
 * Independent of the Vercel AI SDK — can be used standalone for direct
 * snapshot management.
 *
 * @see docs/stateful_mamba/http_api_spec.md
 */

import { ClaritSnapshotError } from '../errors.js';
import type {
  SaveSnapshotRequest,
  SaveSnapshotResponse,
  ListSnapshotsRequest,
  ListSnapshotsResponse,
  GetSnapshotInfoRequest,
  GetSnapshotInfoResponse,
  RestoreSnapshotRequest,
  RestoreSnapshotResponse,
  DeleteSnapshotRequest,
  DeleteSnapshotResponse,
  SnapshotMetadata,
} from './types.js';

export interface SnapshotClientConfig {
  /** Engram server base URL (no trailing slash, no /v1). */
  baseURL: string;
  /** API key for Authorization header. */
  apiKey?: string;
  /** Custom fetch implementation for testing. */
  fetch?: typeof globalThis.fetch;
}

export class ClaritSnapshotClient {
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: SnapshotClientConfig) {
    this.baseURL = config.baseURL.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.fetchFn = config.fetch ?? globalThis.fetch;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Save snapshot state for a live request.
   *
   * Note: Engram returns HTTP 200 even on application-level failures.
   * Always inspect `response.success`.
   */
  async save(request: SaveSnapshotRequest): Promise<SaveSnapshotResponse> {
    return this.post<SaveSnapshotResponse>('/save_snapshot', request);
  }

  /**
   * List snapshot metadata for a conversation.
   *
   * Returns an empty array for unknown conversations (not an error).
   */
  async list(conversationId: string): Promise<SnapshotMetadata[]> {
    const body: ListSnapshotsRequest = { conversation_id: conversationId };
    const response = await this.post<ListSnapshotsResponse>(
      '/list_snapshots',
      body,
    );
    return response.snapshots;
  }

  /**
   * Fetch metadata for a specific snapshot selection.
   */
  async getInfo(
    request: GetSnapshotInfoRequest,
  ): Promise<GetSnapshotInfoResponse> {
    return this.post<GetSnapshotInfoResponse>('/get_snapshot_info', request);
  }

  /**
   * Restore snapshot state.
   *
   * Supports two modes:
   * - Restore-only: omit `create_new_request` or set to false
   * - Restore-and-generate: set `create_new_request=true` with
   *   `continuation_ids` and `max_new_tokens`
   *
   * Note: Application-level failures return HTTP 500. Always parse
   * the JSON body before treating as a transport error.
   */
  async restore(
    request: RestoreSnapshotRequest,
  ): Promise<RestoreSnapshotResponse> {
    return this.post<RestoreSnapshotResponse>('/restore_snapshot', request, {
      allowNon2xx: true,
    });
  }

  /**
   * Delete one snapshot selection within a conversation.
   */
  async delete(
    request: DeleteSnapshotRequest,
  ): Promise<DeleteSnapshotResponse> {
    return this.post<DeleteSnapshotResponse>('/delete_snapshot', request);
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private async post<T>(
    path: string,
    body: unknown,
    options?: { allowNon2xx?: boolean },
  ): Promise<T> {
    const url = `${this.baseURL}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new ClaritSnapshotError({
        message: `Network error calling ${path}: ${error instanceof Error ? error.message : String(error)}`,
        endpoint: path,
      });
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      throw new ClaritSnapshotError({
        message: `Invalid JSON response from ${path} (HTTP ${response.status})`,
        endpoint: path,
        statusCode: response.status,
      });
    }

    // For /restore_snapshot, failures come as HTTP 500 but with valid JSON
    if (!response.ok && !options?.allowNon2xx) {
      const msg =
        (responseBody as Record<string, unknown>)?.message ??
        `HTTP ${response.status}`;
      throw new ClaritSnapshotError({
        message: `Snapshot endpoint ${path} failed: ${msg}`,
        endpoint: path,
        statusCode: response.status,
        responseBody,
      });
    }

    // For /save_snapshot, success:false comes with HTTP 200
    const typed = responseBody as T & { success?: boolean; message?: string };
    if (typed.success === false && !options?.allowNon2xx) {
      throw new ClaritSnapshotError({
        message: `Snapshot operation ${path} failed: ${typed.message ?? 'unknown error'}`,
        endpoint: path,
        statusCode: response.status,
        responseBody,
      });
    }

    return responseBody as T;
  }
}
