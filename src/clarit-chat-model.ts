/**
 * Extended chat language model that adds Engram-native capabilities:
 * - Auto-save snapshot after generation
 * - Restore-and-generate (bypass /v1/chat/completions, use /restore_snapshot)
 * - Compatibility bridge (append-only fast-path for stateless harnesses)
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
import type {
  ClaritProviderOptions,
  ClaritResponseMetadata,
  CompatibilityFallbackReason,
} from './clarit-provider-options.js';
import { ClaritValidationError, ClaritSnapshotError } from './errors.js';
import { isAppendOnly, hasUnsupportedContent } from './compatibility.js';
import type { TokenizeChatMessage } from './snapshots/types.js';

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
  if (meta.compatibilityMode !== undefined) result.compatibilityMode = meta.compatibilityMode;
  if (meta.compatibilityResult !== undefined) result.compatibilityResult = meta.compatibilityResult;
  if (meta.fallbackReason !== undefined) result.fallbackReason = meta.fallbackReason;
  if (meta.snapshotLookupHit !== undefined) result.snapshotLookupHit = meta.snapshotLookupHit;
  if (meta.tokenizationSource !== undefined) result.tokenizationSource = meta.tokenizationSource;
  if (meta.reusedTokenCount !== undefined) result.reusedTokenCount = meta.reusedTokenCount;
  if (meta.continuationTokenCount !== undefined) result.continuationTokenCount = meta.continuationTokenCount;
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

    // ── Compatibility bridge path ──
    if (claritOpts?.compatibilityMode === 'append-only') {
      return this.doCompatibilityGenerate(options, claritOpts);
    }

    // ── Restore-and-generate path ──
    if (claritOpts?.restoreBeforeGenerate) {
      return this.doRestoreAndGenerate(options, claritOpts);
    }

    // ── Standard path (delegate to base model) ──
    return this.doStandardGenerate(options, claritOpts);
  }

  // ─── doStream ──────────────────────────────────────────────────────────

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const claritOpts = this.extractClaritOptions(options);

    // ── Compatibility bridge path ──
    if (claritOpts?.compatibilityMode === 'append-only') {
      const generateResult = await this.doCompatibilityGenerate(options, claritOpts);
      return this.wrapGenerateResultAsStream(generateResult);
    }

    // Restore-and-generate doesn't support streaming (Engram returns a
    // single response). Fall back to doGenerate and wrap as a stream.
    if (claritOpts?.restoreBeforeGenerate) {
      return this.restoreAndGenerateAsStream(options, claritOpts);
    }

    // ── Standard streaming path ──
    return this.doStandardStream(options, claritOpts);
  }

  // ─── Compatibility bridge ──────────────────────────────────────────────

  /**
   * Append-only compatibility bridge.
   *
   * Detects when incoming messages are an append-only extension of a previously
   * snapshotted conversation. If so, uses restore-and-generate fast-path.
   * Otherwise, falls back to standard generation with diagnostics.
   *
   * @experimental
   */
  private async doCompatibilityGenerate(
    options: LanguageModelV3CallOptions,
    claritOpts: ClaritProviderOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    const baseCompatMeta: Partial<ClaritResponseMetadata> = {
      compatibilityMode: 'append-only',
      conversationId: claritOpts.conversationId,
      turnNumber: claritOpts.turnNumber,
      branchName: claritOpts.branchName,
    };

    // Gate: requires conversationId
    if (!claritOpts.conversationId) {
      return this.doCompatibilityFallback(
        options, claritOpts, baseCompatMeta,
        'missing-conversation-id', false,
      );
    }

    // Gate: text-only content (v1 does not handle tool calls or multimodal)
    if (hasUnsupportedContent(options.prompt)) {
      return this.doCompatibilityFallback(
        options, claritOpts, baseCompatMeta,
        'unsupported-content', false,
      );
    }

    // Gate: maxNewTokens required for restore-and-generate
    if (!claritOpts.maxNewTokens || claritOpts.maxNewTokens <= 0) {
      return this.doCompatibilityFallback(
        options, claritOpts, baseCompatMeta,
        'missing-max-tokens', false,
      );
    }

    // Step 1: Tokenize messages via server chat template
    let fullTokenIds: number[];
    try {
      const tokenResponse = await this.snapshotClient.tokenizeChat({
        messages: this.extractMessages(options),
        add_generation_prompt: true,
      });

      if (!tokenResponse.success || !tokenResponse.token_ids) {
        return this.doCompatibilityFallback(
          options, claritOpts, baseCompatMeta,
          'tokenization-error', false,
        );
      }
      fullTokenIds = tokenResponse.token_ids;
    } catch {
      return this.doCompatibilityFallback(
        options, claritOpts, baseCompatMeta,
        'tokenization-error', false,
      );
    }

    // Step 2: Fetch snapshot metadata to get fill_ids
    let snapshotHit = false;
    let fillIds: number[] | undefined;
    try {
      const infoResponse = await this.snapshotClient.getInfo({
        conversation_id: claritOpts.conversationId,
        turn_number: claritOpts.turnNumber,
        branch_name: claritOpts.branchName,
      });
      snapshotHit = infoResponse.success && infoResponse.metadata !== undefined;
      if (snapshotHit && infoResponse.metadata) {
        fillIds = infoResponse.metadata.fill_ids as number[] | undefined;
      }
    } catch {
      snapshotHit = false;
    }

    if (!snapshotHit || !fillIds) {
      return this.doCompatibilityFallback(
        options, claritOpts, baseCompatMeta,
        snapshotHit ? 'fill-ids-missing' : 'no-snapshot',
        snapshotHit,
      );
    }

    // Step 3: Check append-only
    const check = isAppendOnly(fillIds, fullTokenIds);
    if (!check.isAppend) {
      return this.doCompatibilityFallback(
        options, claritOpts, baseCompatMeta,
        'prefix-mismatch',
        true,
      );
    }

    // Fast-path: restore-and-generate with the delta
    const restoreResponse = await this.snapshotClient.restore({
      conversation_id: claritOpts.conversationId,
      turn_number: claritOpts.turnNumber,
      branch_name: claritOpts.branchName,
      create_new_request: true,
      continuation_ids: check.continuationIds,
      max_new_tokens: claritOpts.maxNewTokens,
    });

    if (!restoreResponse.success) {
      throw new ClaritSnapshotError({
        message: `Compatibility fast-path restore failed: ${restoreResponse.message ?? 'unknown error'}`,
        endpoint: '/restore_snapshot',
        responseBody: restoreResponse,
      });
    }

    const outputText = restoreResponse.output_text ?? '';
    const claritMeta: ClaritResponseMetadata = {
      ...baseCompatMeta,
      rid: restoreResponse.rid ?? undefined,
      compatibilityResult: 'fast-path',
      snapshotLookupHit: true,
      tokenizationSource: 'server-chat-template',
      reusedTokenCount: fillIds.length,
      continuationTokenCount: check.continuationIds.length,
    } as ClaritResponseMetadata;

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
          continuation_ids: check.continuationIds,
          max_new_tokens: claritOpts.maxNewTokens,
          compatibility_mode: 'append-only',
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
   * Fallback for compatibility mode — delegates to standard generation
   * and annotates the result with diagnostic metadata.
   */
  private async doCompatibilityFallback(
    options: LanguageModelV3CallOptions,
    claritOpts: ClaritProviderOptions,
    baseMeta: Partial<ClaritResponseMetadata>,
    reason: CompatibilityFallbackReason,
    snapshotHit: boolean,
  ): Promise<LanguageModelV3GenerateResult> {
    const result = await this.baseModel.doGenerate(options);
    const rid = this.extractRidFromResult(result);

    const claritMeta: ClaritResponseMetadata = {
      ...baseMeta,
      rid,
      compatibilityResult: 'fallback',
      fallbackReason: reason,
      snapshotLookupHit: snapshotHit,
    } as ClaritResponseMetadata;

    if (claritOpts.autoSaveSnapshot) {
      const saveResult = await performAutoSave(
        this.snapshotClient,
        rid,
        claritOpts,
      );
      Object.assign(claritMeta, saveResult);
    }

    const existingMeta = result.providerMetadata ?? {};
    result.providerMetadata = {
      ...existingMeta,
      clarit: metadataToJsonRecord(claritMeta),
    };

    return result;
  }

  // ─── Standard paths ──────────────────────────────────────────────────────

  private async doStandardGenerate(
    options: LanguageModelV3CallOptions,
    claritOpts: ClaritProviderOptions | undefined,
  ): Promise<LanguageModelV3GenerateResult> {
    const result = await this.baseModel.doGenerate(options);

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

      const existingMeta = result.providerMetadata ?? {};
      result.providerMetadata = {
        ...existingMeta,
        clarit: metadataToJsonRecord(claritMeta),
      };
    }

    return result;
  }

  private async doStandardStream(
    options: LanguageModelV3CallOptions,
    claritOpts: ClaritProviderOptions | undefined,
  ): Promise<LanguageModelV3StreamResult> {
    const streamResult = await this.baseModel.doStream(options);

    if (!claritOpts?.autoSaveSnapshot) {
      return streamResult;
    }

    const snapshotClient = this.snapshotClient;
    const opts = claritOpts;
    let capturedRid: string | undefined;

    const originalStream = streamResult.stream;
    const transformedStream = originalStream.pipeThrough(
      new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
        transform(chunk, controller) {
          if (chunk.type === 'response-metadata') {
            const meta = chunk as unknown as Record<string, unknown>;
            if (typeof meta.id === 'string') {
              capturedRid = meta.id;
            }
          }

          if (chunk.type === 'finish') {
            const savePromise = performAutoSave(
              snapshotClient,
              capturedRid,
              opts,
            ).catch(() => {});
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

    const outputText = restoreResponse.output_text ?? '';
    const claritMeta: ClaritResponseMetadata = {
      rid: restoreResponse.rid ?? undefined,
      conversationId: claritOpts.conversationId,
      turnNumber: claritOpts.turnNumber,
      branchName: claritOpts.branchName,
    };

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
    return this.wrapGenerateResultAsStream(generateResult);
  }

  /**
   * Wraps any GenerateResult as a single-chunk stream.
   */
  private wrapGenerateResultAsStream(
    generateResult: LanguageModelV3GenerateResult,
  ): LanguageModelV3StreamResult {
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });

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

  /**
   * Extract messages from the V3 prompt for the tokenize_chat endpoint.
   *
   * Converts the V3 prompt format into the simple {role, content} shape
   * that the server's tokenize_chat endpoint expects.
   */
  private extractMessages(
    options: LanguageModelV3CallOptions,
  ): Array<TokenizeChatMessage> {
    return options.prompt.map((msg) => {
      const message = msg as Record<string, unknown>;
      const rawRole = String(message.role ?? 'user');
      const role: TokenizeChatMessage['role'] =
        rawRole === 'system' || rawRole === 'user' || rawRole === 'assistant'
          ? rawRole as TokenizeChatMessage['role']
          : 'user';

      // Handle string content
      if (typeof message.content === 'string') {
        return { role, content: message.content };
      }

      // Handle array content (text parts only — unsupported content already gated)
      if (Array.isArray(message.content)) {
        const textParts = (message.content as Array<Record<string, unknown>>)
          .filter((p) => p.type === 'text')
          .map((p) => String(p.text ?? ''));
        return { role, content: textParts.join('\n') };
      }

      return { role, content: '' };
    });
  }

  private extractRidFromResult(
    result: LanguageModelV3GenerateResult,
  ): string | undefined {
    if (result.response?.id) return result.response.id;

    const body = result.response?.body as Record<string, unknown> | undefined;
    if (typeof body?.id === 'string') return body.id;

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
    return {
      snapshotSaved: false,
      snapshotSaveError:
        error instanceof Error ? error.message : String(error),
    };
  }
}
