/**
 * Extended chat language model that adds Engram-native capabilities:
 * - Auto-save snapshot after generation
 * - Restore-and-generate (bypass /v1/chat/completions, use /restore_snapshot)
 *
 * Wraps the OpenAI-compatible chat model from @ai-sdk/openai-compatible
 * and intercepts doGenerate/doStream to inject Clarit behavior.
 *
 * Implements LanguageModelV3 from @ai-sdk/provider.
 */

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
} from '@ai-sdk/provider';
import { ClaritSnapshotClient } from './snapshots/snapshot-client.js';
import type { ClaritProviderOptions, ClaritResponseMetadata } from './clarit-provider-options.js';
import { ClaritValidationError, ClaritSnapshotError } from './errors.js';

export interface ClaritChatModelConfig {
  /** The base OpenAI-compatible language model to delegate standard calls to. */
  baseModel: LanguageModelV3;
  /** Snapshot client for save/restore operations. */
  snapshotClient: ClaritSnapshotClient;
}

/**
 * Convert ClaritResponseMetadata to a JSON-safe record that satisfies
 * SharedV3ProviderMetadata's Record<string, JSONValue> constraint.
 */
function metadataToJsonRecord(
  meta: ClaritResponseMetadata,
): Record<string, string | number | boolean | null> {
  const result: Record<string, string | number | boolean | null> = {};
  if (meta.rid !== undefined) result.rid = meta.rid;
  if (meta.snapshotSaved !== undefined) result.snapshotSaved = meta.snapshotSaved;
  if (meta.snapshotId !== undefined) result.snapshotId = meta.snapshotId;
  if (meta.conversationId !== undefined) result.conversationId = meta.conversationId;
  if (meta.turnNumber !== undefined) result.turnNumber = meta.turnNumber;
  if (meta.branchName !== undefined) result.branchName = meta.branchName;
  if (meta.snapshotSaveError !== undefined) result.snapshotSaveError = meta.snapshotSaveError;
  return result;
}

export class ClaritChatModel implements LanguageModelV3 {
  readonly specificationVersion = 'v3';
  readonly provider: string;
  readonly modelId: string;

  private readonly baseModel: LanguageModelV3;
  private readonly snapshotClient: ClaritSnapshotClient;

  constructor(config: ClaritChatModelConfig) {
    this.baseModel = config.baseModel;
    this.snapshotClient = config.snapshotClient;

    // Delegate identity from the wrapped model
    this.provider = this.baseModel.provider;
    this.modelId = this.baseModel.modelId;
  }

  get supportedUrls() {
    return this.baseModel.supportedUrls ?? {};
  }

  // ─── doGenerate ────────────────────────────────────────────────────────

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    const claritOpts = this.extractClaritOptions(options);

    // ── Restore-and-generate path ──
    if (claritOpts?.restoreBeforeGenerate) {
      return this.doRestoreAndGenerate(options, claritOpts);
    }

    // ── Standard path (delegate to base model) ──
    const result = await this.baseModel.doGenerate(options);

    // ── Extract rid + auto-save hook ──
    if (claritOpts) {
      const rid = this.extractRidFromResult(result);
      const claritMeta: ClaritResponseMetadata = {
        rid,
        conversationId: claritOpts.conversationId,
        turnNumber: claritOpts.turnNumber,
        branchName: claritOpts.branchName,
      };

      if (claritOpts.autoSaveSnapshot) {
        const saveResult = await performAutoSave(
          this.snapshotClient,
          rid,
          claritOpts,
        );
        Object.assign(claritMeta, saveResult);
      }

      // Inject provider metadata
      const existingMeta = result.providerMetadata ?? {};
      result.providerMetadata = {
        ...existingMeta,
        clarit: metadataToJsonRecord(claritMeta),
      };
    }

    return result;
  }

  // ─── doStream ──────────────────────────────────────────────────────────

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const claritOpts = this.extractClaritOptions(options);

    // Restore-and-generate doesn't support streaming (Engram returns a
    // single response). Fall back to doGenerate and wrap as a stream.
    if (claritOpts?.restoreBeforeGenerate) {
      return this.restoreAndGenerateAsStream(options, claritOpts);
    }

    // ── Standard streaming path ──
    const streamResult = await this.baseModel.doStream(options);

    if (!claritOpts?.autoSaveSnapshot) {
      return streamResult;
    }

    // ── Wrap stream to hook auto-save after finish ──
    const snapshotClient = this.snapshotClient;
    const opts = claritOpts;
    let capturedRid: string | undefined;

    const originalStream = streamResult.stream;
    const transformedStream = originalStream.pipeThrough(
      new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
        transform(chunk, controller) {
          // Capture rid from response-metadata
          if (chunk.type === 'response-metadata') {
            const meta = chunk as unknown as Record<string, unknown>;
            if (typeof meta.id === 'string') {
              capturedRid = meta.id;
            }
          }

          // On finish, fire auto-save
          if (chunk.type === 'finish') {
            // Fire auto-save asynchronously — don't block the stream
            const savePromise = performAutoSave(
              snapshotClient,
              capturedRid,
              opts,
            ).catch(() => {
              // Best-effort: save failure doesn't break the stream
            });
            void savePromise;
          }

          controller.enqueue(chunk);
        },
      }),
    );

    return {
      ...streamResult,
      stream: transformedStream,
    };
  }

  // ─── Restore-and-generate ──────────────────────────────────────────────

  private async doRestoreAndGenerate(
    _options: LanguageModelV3CallOptions,
    claritOpts: ClaritProviderOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    // Validate required fields
    if (!claritOpts.continuationIds || claritOpts.continuationIds.length === 0) {
      throw new ClaritValidationError(
        'restoreBeforeGenerate requires continuationIds (tokenized new-turn tokens)',
      );
    }
    if (!claritOpts.maxNewTokens || claritOpts.maxNewTokens <= 0) {
      throw new ClaritValidationError(
        'restoreBeforeGenerate requires maxNewTokens > 0',
      );
    }
    if (!claritOpts.conversationId) {
      throw new ClaritValidationError(
        'restoreBeforeGenerate requires conversationId',
      );
    }

    // Call the Engram restore-and-generate endpoint
    const restoreResponse = await this.snapshotClient.restore({
      conversation_id: claritOpts.conversationId,
      turn_number: claritOpts.turnNumber,
      branch_name: claritOpts.branchName,
      create_new_request: true,
      continuation_ids: claritOpts.continuationIds,
      max_new_tokens: claritOpts.maxNewTokens,
    });

    if (!restoreResponse.success) {
      throw new ClaritSnapshotError({
        message: `Restore-and-generate failed: ${restoreResponse.message ?? 'unknown error'}`,
        endpoint: '/restore_snapshot',
        responseBody: restoreResponse,
      });
    }

    // Map Engram restore response to AI SDK V3 GenerateResult
    const outputText = restoreResponse.output_text ?? '';
    const claritMeta: ClaritResponseMetadata = {
      rid: restoreResponse.rid ?? undefined,
      conversationId: claritOpts.conversationId,
      turnNumber: claritOpts.turnNumber,
      branchName: claritOpts.branchName,
    };

    // Auto-save the newly generated state
    if (claritOpts.autoSaveSnapshot && restoreResponse.rid) {
      const saveResult = await performAutoSave(
        this.snapshotClient,
        restoreResponse.rid,
        claritOpts,
      );
      Object.assign(claritMeta, saveResult);
    }

    return {
      content: outputText ? [{ type: 'text' as const, text: outputText }] : [],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: {
          total: restoreResponse.token_count ?? 0,
          noCache: undefined,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: restoreResponse.output_ids?.length ?? 0,
          text: undefined,
          reasoning: undefined,
        },
      },
      request: {
        body: {
          conversation_id: claritOpts.conversationId,
          continuation_ids: claritOpts.continuationIds,
          max_new_tokens: claritOpts.maxNewTokens,
        },
      },
      response: {
        id: restoreResponse.rid ?? undefined,
      },
      warnings: [],
      providerMetadata: {
        clarit: metadataToJsonRecord(claritMeta),
      },
    };
  }

  /**
   * Wraps a restore-and-generate result as a single-chunk stream
   * for the doStream path.
   */
  private async restoreAndGenerateAsStream(
    options: LanguageModelV3CallOptions,
    claritOpts: ClaritProviderOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const generateResult = await this.doRestoreAndGenerate(options, claritOpts);

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });

        // Extract text from content array
        const textContent = generateResult.content.find(
          (c): c is { type: 'text'; text: string } => c.type === 'text',
        );
        if (textContent) {
          controller.enqueue({
            type: 'text-delta',
            id: 'restore',
            delta: textContent.text,
          });
        }

        controller.enqueue({
          type: 'finish',
          finishReason: generateResult.finishReason,
          usage: generateResult.usage,
        });
        controller.close();
      },
    });

    return {
      stream,
      request: generateResult.request,
      response: { headers: {} },
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private extractClaritOptions(
    options: LanguageModelV3CallOptions,
  ): ClaritProviderOptions | undefined {
    return options.providerOptions?.clarit as ClaritProviderOptions | undefined;
  }

  private extractRidFromResult(
    result: LanguageModelV3GenerateResult,
  ): string | undefined {
    // V3: response.id
    if (result.response?.id) return result.response.id;

    // V3: response.body?.id
    const body = result.response?.body as Record<string, unknown> | undefined;
    if (typeof body?.id === 'string') return body.id;

    // Try provider metadata
    const meta = result.providerMetadata;
    const claritMeta = meta?.clarit as Record<string, unknown> | undefined;
    if (typeof claritMeta?.rid === 'string') return claritMeta.rid;

    return undefined;
  }
}

/**
 * Auto-save helper — fires POST /save_snapshot and returns result metadata.
 * Best-effort: returns error info instead of throwing.
 */
async function performAutoSave(
  client: ClaritSnapshotClient,
  rid: string | undefined,
  opts: ClaritProviderOptions,
): Promise<Partial<ClaritResponseMetadata>> {
  try {
    const saveResponse = await client.save({
      rid: rid,
      conversation_id: opts.conversationId,
      turn_number: opts.turnNumber,
      branch_name: opts.branchName,
    });

    return {
      snapshotSaved: saveResponse.success,
      snapshotId: saveResponse.snapshot_id,
    };
  } catch (error) {
    // Auto-save is best-effort
    return {
      snapshotSaved: false,
      snapshotSaveError:
        error instanceof Error ? error.message : String(error),
    };
  }
}