/**
 * Snapshot request/response types derived from the Engram HTTP API spec.
 *
 * @see docs/stateful_mamba/http_api_spec.md
 */

// ─── Save Snapshot ───────────────────────────────────────────────────────────

export interface SaveSnapshotRequest {
  /** Live request identifier. */
  rid?: string;
  /** Optional custom snapshot ID. */
  snapshot_id?: string;
  /** Stable conversation grouping key. */
  conversation_id?: string;
  /** Turn number on the main conversation line. */
  turn_number?: number;
  /** Branch name for alternate branches. */
  branch_name?: string;
}

export interface SaveSnapshotResponse {
  success: boolean;
  snapshot_id?: string;
  message?: string;
}

// ─── Tokenize Chat ───────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────

/** @experimental */
export interface TokenizeChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** @experimental */
export interface TokenizeChatRequest {
  messages: TokenizeChatMessage[];
  add_generation_prompt?: boolean;
}

/** @experimental */
export interface TokenizeChatResponse {
  success: boolean;
  token_ids?: number[];
  token_count?: number;
  chat_template_name?: string | null;
  message?: string;
}
}

// ─── List Snapshots ──────────────────────────────────────────────────────────

export interface ListSnapshotsRequest {
  conversation_id: string;
}

export interface SnapshotMetadata {
  conversation_id: string;
  turn_number?: number;
  branch_name?: string | null;
  timestamp?: number;
  token_count?: number;
  model_name?: string;
  /** Additional implementation-defined metadata fields. */
  [key: string]: unknown;
}

export interface ListSnapshotsResponse {
  success: boolean;
  snapshots: SnapshotMetadata[];
}

// ─── Get Snapshot Info ───────────────────────────────────────────────────────

export interface GetSnapshotInfoRequest {
  conversation_id: string;
  turn_number?: number;
  branch_name?: string;
}

export interface GetSnapshotInfoResponse {
  success: boolean;
  metadata?: SnapshotMetadata;
  message?: string;
}

// ─── Restore Snapshot ────────────────────────────────────────────────────────

export interface RestoreSnapshotRequest {
  /** Live request identifier (for restore-only into a live request). */
  rid?: string;
  /** Conversation to restore from. */
  conversation_id?: string;
  /** Turn to restore from. */
  turn_number?: number;
  /** Branch to restore from. */
  branch_name?: string;
  /** When true, creates a new request and generates continuation. */
  create_new_request?: boolean;
  /** Tokenized continuation tokens (required when create_new_request=true). */
  continuation_ids?: number[];
  /** Max tokens to generate (required when create_new_request=true). */
  max_new_tokens?: number;
  /** Optional correlation ID. */
  request_id?: string;
}

export interface RestoreSnapshotResponse {
  success: boolean;
  rid?: string | null;
  mamba_pool_idx?: number | null;
  message?: string;
  token_count?: number | null;
  output_ids?: number[] | null;
  output_text?: string | null;
}

// ─── Delete Snapshot ─────────────────────────────────────────────────────────

export interface DeleteSnapshotRequest {
  conversation_id: string;
  turn_number?: number;
  branch_name?: string;
}

export interface DeleteSnapshotResponse {
  success: boolean;
  message?: string;
}
