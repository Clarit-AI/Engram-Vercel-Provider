/**
 * Clarit-specific provider options passed via `providerOptions.clarit`.
 *
 * These are the features that differentiate Clarit from every other
 * OpenAI-compatible provider — persistent Mamba state, snapshot management,
 * and restore-and-generate.
 */
export interface ClaritProviderOptions {
  // --- Session tracking ---

  /** Stable conversation identifier for snapshot management. */
  conversationId?: string;

  /** Turn number for snapshot selection on the main conversation line. */
  turnNumber?: number;

  /** Branch name for alternate conversation branches. */
  branchName?: string;

  // --- Engram-native statefulness features ---

  /**
   * Auto-save a snapshot after this generation completes.
   *
   * When true, the provider fires `POST /save_snapshot` using the `rid` from
   * the generation response plus the `conversationId`, `turnNumber`, and
   * `branchName` from these options.
   *
   * Works for both `generateText` (synchronous) and `streamText` (fires after
   * stream completes).
   */
  autoSaveSnapshot?: boolean;

  /**
   * Restore from a previous snapshot before generating.
   *
   * When set, the provider calls `POST /restore_snapshot` with
   * `create_new_request=true` INSTEAD of the normal `/v1/chat/completions`
   * path. This is the signature Engram restore-and-generate flow.
   *
   * Requires `continuationIds` and `maxNewTokens`.
   */
  restoreBeforeGenerate?: boolean;

  /**
   * Tokenized continuation IDs for restore-and-generate mode.
   *
   * These are the tokenized new-turn tokens to append after restoring
   * snapshot state. Required when `restoreBeforeGenerate` is true.
   *
   * Typically produced by running the new user message through the same
   * tokenizer and chat template the server uses.
   */
  continuationIds?: number[];

  /**
   * Max new tokens for restore-and-generate mode.
   * Required when `restoreBeforeGenerate` is true.
   * Also reused by compatibility mode fast-path.
   */
  maxNewTokens?: number;

  // --- Compatibility bridge ---

  /**
   * Enable stateless compatibility mode for legacy chat harnesses.
   *
   * When set to `'append-only'`, the provider will:
   * 1. Tokenize messages via the server's `/tokenize_chat` endpoint
   * 2. Fetch the latest snapshot's `fill_ids` from `/get_snapshot_info`
   * 3. If the incoming messages are an append-only extension of the
   *    snapshotted state, use restore-and-generate (fast path)
   * 4. Otherwise, fall back to standard `/v1/chat/completions`
   *
   * Requires `conversationId` and `autoSaveSnapshot: true` for best results.
   * Requires `maxNewTokens` for the fast path.
   *
   * @experimental
   */
  compatibilityMode?: 'append-only' | false;
}

/**
 * Reasons the compatibility bridge fell back to stateless mode.
 */
export type CompatibilityFallbackReason =
  | 'missing-max-tokens'
  | 'no-snapshot'
  | 'fill-ids-missing'
  | 'prefix-mismatch'
  | 'unsupported-content'
  | 'tokenization-error'
  | 'missing-conversation-id';

/**
 * Metadata returned in `providerMetadata.clarit` after generation.
 */
export interface ClaritResponseMetadata {
  /** Request ID from the generation. */
  rid?: string;

  /** Whether auto-save was attempted and succeeded. */
  snapshotSaved?: boolean;

  /** Snapshot ID if a save was performed. */
  snapshotId?: string;

  /** Echoed conversation ID for client tracking. */
  conversationId?: string;

  /** Echoed turn number for client tracking. */
  turnNumber?: number;

  /** Echoed branch name for client tracking. */
  branchName?: string;

  /** Error message if auto-save failed (save is best-effort). */
  snapshotSaveError?: string;

  // --- Compatibility bridge diagnostics ---

  /** Echoes the input compatibility mode config. */
  compatibilityMode?: 'disabled' | 'append-only';

  /** Outcome of compatibility bridge evaluation. */
  compatibilityResult?: 'fast-path' | 'fallback' | 'not-applicable';

  /** Why fallback was taken (only when compatibilityResult is 'fallback'). */
  fallbackReason?: CompatibilityFallbackReason;

  /** Whether a snapshot was found for the conversation. */
  snapshotLookupHit?: boolean;

  /** How token IDs were obtained. Reinforces server-side truth. */
  tokenizationSource?: 'server-chat-template';

  /** Tokens reused from snapshot (fast-path only). */
  reusedTokenCount?: number;

  /** New tokens sent as continuation (fast-path only). */
  continuationTokenCount?: number;
}
