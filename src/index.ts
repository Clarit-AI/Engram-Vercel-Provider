/**
 * @claritai/vercel-ai-provider
 *
 * Vercel AI SDK provider for Clarit (Engram) — persistent Mamba state
 * as a drop-in for the JS/TS ecosystem.
 *
 * @example
 * ```ts
 * import { createClarit } from '@claritai/vercel-ai-provider';
 * import { generateText } from 'ai';
 *
 * const clarit = createClarit({ baseURL: 'http://gpu-server:30000' });
 *
 * // Standard generation with auto-save
 * const { text } = await generateText({
 *   model: clarit('granite-4.0-h-small'),
 *   messages: [{ role: 'user', content: 'My favorite color is blue.' }],
 *   providerOptions: {
 *     clarit: {
 *       conversationId: 'session-1',
 *       turnNumber: 1,
 *       autoSaveSnapshot: true,
 *     },
 *   },
 * });
 *
 * // Restore-and-generate
 * const { text: recalled } = await generateText({
 *   model: clarit('granite-4.0-h-small'),
 *   messages: [],
 *   providerOptions: {
 *     clarit: {
 *       conversationId: 'session-1',
 *       restoreBeforeGenerate: true,
 *       continuationIds: [1, 2, 3],
 *       maxNewTokens: 128,
 *     },
 *   },
 * });
 * ```
 */

// Provider
export { createClarit, clarit } from './clarit-provider.js';
export type {
  ClaritProvider,
  ClaritProviderSettings,
} from './clarit-provider.js';

// Provider options
export type {
  ClaritProviderOptions,
  ClaritResponseMetadata,
} from './clarit-provider-options.js';

// Chat model
export { ClaritChatModel } from './clarit-chat-model.js';
export type { ClaritChatModelConfig } from './clarit-chat-model.js';

// Snapshot client (also available via subpath import)
export { ClaritSnapshotClient } from './snapshots/snapshot-client.js';
export type { SnapshotClientConfig } from './snapshots/snapshot-client.js';

// Errors
export { ClaritSnapshotError, ClaritValidationError } from './errors.js';
