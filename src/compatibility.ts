/**
 * Pure functions for the append-only compatibility bridge.
 *
 * @experimental
 */

import type {
  CompatibilityFallbackReason,
} from './clarit-provider-options.js';

/**
 * Result of checking whether a snapshot's fill_ids is a prefix of the full token array.
 * Discriminated union — when isAppend is true, continuationIds is always present.
 */
export type AppendOnlyCheckResult =
  | { isAppend: false }
  | { isAppend: true; continuationIds: number[] };

/**
 * Check whether snapshot fill_ids form an exact prefix of the full token array,
 * and compute the unsaved delta.
 *
 * This is the core correctness gate for the compatibility bridge.
 * A false result means the conversation has been edited and we must fall back.
 */
export function isAppendOnly(
  fillIds: number[],
  fullTokenIds: number[],
): AppendOnlyCheckResult {
  // fill_ids must be shorter than full tokenization
  if (fillIds.length === 0 || fillIds.length >= fullTokenIds.length) {
    return { isAppend: false };
  }

  // Check element-by-element that fill_ids is an exact prefix
  for (let i = 0; i < fillIds.length; i++) {
    if (fillIds[i] !== fullTokenIds[i]) {
      return { isAppend: false };
    }
  }

  // Exact prefix match — the delta is the remainder
  const continuationIds = fullTokenIds.slice(fillIds.length);

  // Nothing new to generate — not an error, but not applicable for fast-path
  if (continuationIds.length === 0) {
    return { isAppend: false };
  }

  return { isAppend: true, continuationIds };
}

/**
 * Check whether a V3 prompt contains only text-only content supported by
 * the compatibility bridge v1.
 *
 * Returns true if the prompt contains tool calls, tool results, file parts,
 * reasoning parts, or any non-text content that the bridge cannot handle.
 */
export function hasUnsupportedContent(
  prompt: Array<unknown>,
): boolean {
  if (prompt.length === 0) {
    return true;
  }

  for (const message of prompt) {
    // Guard against null, undefined, or non-object entries
    if (message == null || typeof message !== 'object') {
      return true;
    }

    const msg = message as Record<string, unknown>;
    const content = msg.content;

    // content must be present
    if (content === undefined || content === null) {
      return true;
    }

    // String content is fine (system message or simple content)
    if (typeof content === 'string') {
      continue;
    }

    // Array content — check each part
    if (Array.isArray(content)) {
      for (const part of content) {
        const p = part as Record<string, unknown>;
        if (!p || typeof p !== 'object' || p.type !== 'text') {
          return true;
        }
      }
      continue;
    }

    // Any other content type (file, reasoning, etc.) is unsupported
    return true;
  }

  return false;
}

/**
 * Build compatibility bridge diagnostic metadata for a fallback result.
 */
export function buildFallbackMetadata(
  mode: 'append-only',
  reason: CompatibilityFallbackReason,
  snapshotHit: boolean,
): Record<string, unknown> {
  return {
    compatibilityMode: mode,
    compatibilityResult: 'fallback' as const,
    fallbackReason: reason,
    snapshotLookupHit: snapshotHit,
  };
}
