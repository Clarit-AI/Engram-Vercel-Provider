/**
 * Extended chat language model that adds Engram-native capabilities:
 * - Auto-save snapshot after generation
 * - Restore-and-generate (bypass /v1/chat/completions, use /restore_snapshot)
 *
 * Wraps the OpenAI-compatible chat model from @ai-sdk/openai-compatible
 * and intercepts doGenerate/doStream to inject Clarit behavior.
 */

import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1StreamPart,
  LanguageModelV1ProviderMetadata,
} from '@ai-sdk/provider';
import { ClaritSnapshotClient } from './snapshots/snapshot-client.js';
import type { ClaritProviderOptions, ClaritResponseMetadata } from './clarit-provider-options.js';
import { ClaritValidationError, ClaritSnapshotError } from './errors.js';

export interface ClaritChatModelConfig {
  /** The base OpenAI-compatible language model to delegate standard calls to. */
  baseModel: LanguageModelV1;
  /** Snapshot client for save/restore operations. */
  snapshotClient: ClaritSnapshotClient;
}

/**
 * Convert ClaritResponseMetadata to a JSON-safe record that satisfies
 * LanguageModelV1ProviderMetadata's Record<string, JSONValue> constraint.
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

export class ClaritChatModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1';
  readonly provider: string;
  readonly modelId: string;
  readonly defaultObjectGenerationMode: LanguageModelV1['defaultObjectGenerationMode'];

  private readonly baseModel: LanguageModelV1;
  private readonly snapshotClient: ClaritSnapshotClient;

  constructor(config: ClaritChatModelConfig) {
    this.baseModel = config.baseModel;
    this.snapshotClient = config.snapshotClient;

    // Delegate identity from the wrapped model
    this.provider = this.baseModel.provider;
    this.modelId = this.baseModel.modelId;
    this.defaultObjectGenerationMode = this.baseModel.defaultObjectGenerationMode;
  }

  get supportsUrl() {
    return this.baseModel.supportsUrl;
  }

  // ─── doGenerate ────────────────────────────────────────────────────────

  async doGenerate(
    options: LanguageModelV1CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV1['doGenerate']>>> {
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
    options: LanguageModelV1CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV1['doStream']>>> {
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
      new TransformStream<LanguageModelV1StreamPart, LanguageModelV1StreamPart>({
        transform(chunk, controller) {
          // Capture rid from response-metadata
          if (chunk.type === 'response-metadata') {
            const meta = chunk as Record<string, unknown>;
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
    _options: LanguageModelV1CallOptions,
    claritOpts: ClaritProviderOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV1['doGenerate']>>> {
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

    // Map Engram restore response to AI SDK GenerateResult
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

    const providerMetadata: LanguageModelV1ProviderMetadata = {
      clarit: metadataToJsonRecord(claritMeta),
    };

    return {
      text: outputText,
      toolCalls: undefined,
      finishReason: 'stop' as const,
      usage: {
        promptTokens: restoreResponse.token_count ?? 0,
        completionTokens: restoreResponse.output_ids?.length ?? 0,
      },
      rawCall: {
        rawPrompt: claritOpts.continuationIds,
        rawSettings: {
          conversation_id: claritOpts.conversationId,
          turn_number: claritOpts.turnNumber,
          max_new_tokens: claritOpts.maxNewTokens,
        },
      },
      rawResponse: {
        headers: undefined,
      },
      warnings: [],
      providerMetadata,
    };
  }

  /**
   * Wraps a restore-and-generate result as a single-chunk stream
   * for the doStream path.
   */
  private async restoreAndGenerateAsStream(
    options: LanguageModelV1CallOptions,
    claritOpts: ClaritProviderOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV1['doStream']>>> {
    const generateResult = await this.doRestoreAndGenerate(options, claritOpts);

    const stream = new ReadableStream<LanguageModelV1StreamPart>({
      start(controller) {
        if (generateResult.text) {
          controller.enqueue({
            type: 'text-delta',
            textDelta: generateResult.text,
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
      rawCall: generateResult.rawCall,
      rawResponse: generateResult.rawResponse,
      warnings: generateResult.warnings,
    };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private extractClaritOptions(
    options: LanguageModelV1CallOptions,
  ): ClaritProviderOptions | undefined {
    const providerOptions = (options as Record<string, unknown>)
      .providerOptions as Record<string, unknown> | undefined;
    return providerOptions?.clarit as ClaritProviderOptions | undefined;
  }

  private extractRidFromResult(
    result: Awaited<ReturnType<LanguageModelV1['doGenerate']>>,
  ): string | undefined {
    // Try to get rid from the raw response body
    const rawResponse = result.rawResponse as Record<string, unknown> | undefined;
    if (rawResponse) {
      // The OpenAI-format response has `id` at the top level
      if (typeof rawResponse.id === 'string') return rawResponse.id;
      // Some providers nest it in body
      const body = rawResponse.body as Record<string, unknown> | undefined;
      if (typeof body?.id === 'string') return body.id;
    }

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
