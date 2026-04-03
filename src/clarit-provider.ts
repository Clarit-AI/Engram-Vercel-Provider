/**
 * Clarit provider factory.
 *
 * Creates a Vercel AI SDK-compatible provider with Engram-native capabilities:
 * - Standard OpenAI-compatible chat completions
 * - Auto-save snapshot lifecycle
 * - Restore-and-generate stateful inference
 * - Direct snapshot management via `clarit.snapshots`
 *
 * @example
 * ```ts
 * import { createClarit } from '@clarit.ai/vercel-ai-provider';
 * import { generateText } from 'ai';
 *
 * const clarit = createClarit({ baseURL: 'http://gpu-server:30000' });
 *
 * const { text } = await generateText({
 *   model: clarit('granite-4.0-h-small'),
 *   messages: [{ role: 'user', content: 'Hello!' }],
 *   providerOptions: {
 *     clarit: { conversationId: 'session-1', autoSaveSnapshot: true },
 *   },
 * });
 * ```
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV1 } from '@ai-sdk/provider';
import { ClaritChatModel } from './clarit-chat-model.js';
import { ClaritSnapshotClient } from './snapshots/snapshot-client.js';

// ─── Settings ────────────────────────────────────────────────────────────────

export interface ClaritProviderSettings {
  /**
   * Engram server base URL.
   * @default 'http://localhost:30000'
   */
  baseURL?: string;

  /**
   * API key for authentication.
   * Falls back to `CLARIT_API_KEY` environment variable.
   */
  apiKey?: string;

  /**
   * Admin API key for snapshot routes (takes precedence over `apiKey`
   * when both are configured on the server).
   * Falls back to `CLARIT_ADMIN_API_KEY` environment variable.
   */
  adminApiKey?: string;

  /**
   * Custom headers to include in all requests.
   */
  headers?: Record<string, string>;

  /**
   * Custom fetch implementation (useful for testing or middleware).
   */
  fetch?: typeof globalThis.fetch;
}

// ─── Provider interface ──────────────────────────────────────────────────────

export interface ClaritProvider {
  /**
   * Create a Clarit language model instance.
   *
   * @param modelId - The model identifier (e.g., 'granite-4.0-h-small')
   * @returns A language model with Engram-native capabilities
   */
  (modelId: string): LanguageModelV1;

  /**
   * Create a Clarit language model instance (explicit method).
   */
  languageModel(modelId: string): LanguageModelV1;

  /**
   * Create a Clarit chat model instance.
   */
  chatModel(modelId: string): LanguageModelV1;

  /**
   * Snapshot management utilities.
   *
   * Provides direct access to Engram snapshot endpoints independent
   * of the Vercel AI SDK generation flow.
   */
  snapshots: ClaritSnapshotClient;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create a Clarit provider instance.
 *
 * @param options - Provider configuration
 * @returns A Clarit provider with Engram-native statefulness features
 */
export function createClarit(
  options: ClaritProviderSettings = {},
): ClaritProvider {
  const baseURL = (options.baseURL ?? 'http://localhost:30000').replace(
    /\/+$/,
    '',
  );
  const apiKey =
    options.apiKey ?? process.env.CLARIT_API_KEY;
  const adminApiKey =
    options.adminApiKey ?? process.env.CLARIT_ADMIN_API_KEY;
  const effectiveSnapshotKey = adminApiKey ?? apiKey;

  // Create the base OpenAI-compatible provider for standard chat/completions
  const baseProvider = createOpenAICompatible({
    name: 'clarit',
    baseURL: `${baseURL}/v1`,
    apiKey,
    headers: options.headers,
  });

  // Create the snapshot client for Engram-specific endpoints
  const snapshotClient = new ClaritSnapshotClient({
    baseURL,
    apiKey: effectiveSnapshotKey,
    fetch: options.fetch,
  });

  // Wrap base models with Clarit-enhanced versions that add
  // auto-save and restore-and-generate capabilities
  const createClaritModel = (modelId: string): LanguageModelV1 => {
    const baseModel = baseProvider.chatModel(modelId);
    return new ClaritChatModel({
      baseModel,
      snapshotClient,
    });
  };

  // Build the provider function/object
  const provider = (modelId: string) => createClaritModel(modelId);
  provider.languageModel = createClaritModel;
  provider.chatModel = createClaritModel;
  provider.snapshots = snapshotClient;

  return provider as ClaritProvider;
}

/**
 * Default Clarit provider instance.
 *
 * Uses environment variables for configuration:
 * - `CLARIT_BASE_URL` or defaults to `http://localhost:30000`
 * - `CLARIT_API_KEY` for authentication
 * - `CLARIT_ADMIN_API_KEY` for admin/snapshot routes
 */
export const clarit = createClarit({
  baseURL: process.env.CLARIT_BASE_URL,
});
