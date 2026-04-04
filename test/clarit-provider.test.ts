/**
 * Unit tests for the Clarit provider factory and ClaritChatModel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClarit } from '../src/clarit-provider.js';
import { ClaritChatModel } from '../src/clarit-chat-model.js';
import { ClaritSnapshotClient } from '../src/snapshots/snapshot-client.js';
import { ClaritValidationError } from '../src/errors.js';
import type { LanguageModelV3 } from '@ai-sdk/provider';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockBaseModel(): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'clarit.chat',
    modelId: 'granite-4.0-h-small',
    supportedUrls: {},
    doGenerate: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'Hello from Granite!' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: undefined, reasoning: undefined },
      },
      response: { id: 'req-abc', body: { id: 'req-abc' } },
      warnings: [],
    }),
    doStream: vi.fn().mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] });
          controller.enqueue({ type: 'text-delta', id: 'text-0', delta: 'Hello' });
          controller.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: undefined, reasoning: undefined },
            },
          });
          controller.close();
        },
      }),
      response: { headers: {} },
    }),
  };
}

function createMockSnapshotClient(overrides?: {
  fillIds?: number[];
}) {
  const fillIds = overrides?.fillIds ?? [1, 2, 3]; // default fill_ids for tests

  return {
    save: vi.fn().mockResolvedValue({
      success: true,
      snapshot_id: 'snap-001',
    }),
    list: vi.fn().mockResolvedValue([]),
    getInfo: vi.fn().mockResolvedValue({
      success: true,
      metadata: {
        conversation_id: 'session-1',
        turn_number: 1,
        fill_ids: fillIds,
        model_name: 'granite-4.0-h-small',
        token_count: fillIds.length,
      },
    }),
    restore: vi.fn().mockResolvedValue({
      success: true,
      rid: 'restored-req-1',
      output_text: 'Blue is your favorite color.',
      output_ids: [101, 202],
      token_count: 64,
    }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    tokenizeChat: vi.fn().mockResolvedValue({
      success: true,
      token_ids: [...fillIds, 4, 5], // append-only by default
      token_count: fillIds.length + 2,
      chat_template_name: 'granite-chat',
    }),
  } as unknown as ClaritSnapshotClient;
}

// ─── Provider Factory ────────────────────────────────────────────────────────

describe('createClarit', () => {
  it('creates a callable provider', () => {
    const provider = createClarit({ baseURL: 'http://localhost:30000' });
    expect(typeof provider).toBe('function');
    expect(typeof provider.languageModel).toBe('function');
    expect(typeof provider.chatModel).toBe('function');
    expect(provider.snapshots).toBeDefined();
  });

  it('returns ClaritChatModel from languageModel()', () => {
    const provider = createClarit({ baseURL: 'http://localhost:30000' });
    const model = provider.languageModel('granite-4.0-h-small');
    expect(model).toBeInstanceOf(ClaritChatModel);
    expect(model.modelId).toBe('granite-4.0-h-small');
  });

  it('exposes snapshot client', () => {
    const provider = createClarit({ baseURL: 'http://localhost:30000' });
    expect(provider.snapshots).toBeInstanceOf(ClaritSnapshotClient);
  });
});

// ─── ClaritChatModel ─────────────────────────────────────────────────────────

describe('ClaritChatModel', () => {
  let baseModel: LanguageModelV3;
  let snapshotClient: ReturnType<typeof createMockSnapshotClient>;
  let model: ClaritChatModel;

  beforeEach(() => {
    baseModel = createMockBaseModel();
    snapshotClient = createMockSnapshotClient();
    model = new ClaritChatModel({
      baseModel,
      snapshotClient: snapshotClient as unknown as ClaritSnapshotClient,
    });
  });

  describe('standard generation (no Clarit options)', () => {
    it('delegates to base model', async () => {
      const result = await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      });

      expect(baseModel.doGenerate).toHaveBeenCalled();
      expect(result.content).toEqual([{ type: 'text', text: 'Hello from Granite!' }]);
    });

    it('does not call snapshot client', async () => {
      await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      });

      expect(snapshotClient.save).not.toHaveBeenCalled();
    });
  });

  describe('auto-save snapshot', () => {
    it('saves snapshot after generation', async () => {
      const result = await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        providerOptions: {
          clarit: {
            conversationId: 'session-1',
            turnNumber: 1,
            autoSaveSnapshot: true,
          },
        },
      });

      expect(snapshotClient.save).toHaveBeenCalledWith({
        rid: 'req-abc', // rid extracted from response.id
        conversation_id: 'session-1',
        turn_number: 1,
        branch_name: undefined,
      });

      const claritMeta = result.providerMetadata?.clarit;
      expect(claritMeta).toBeDefined();
      expect(claritMeta?.snapshotSaved).toBe(true);
      expect(claritMeta?.snapshotId).toBe('snap-001');
    });

    it('reports save failure gracefully', async () => {
      (snapshotClient.save as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Network error'),
      );

      const result = await model.doGenerate({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        providerOptions: {
          clarit: {
            conversationId: 'session-1',
            autoSaveSnapshot: true,
          },
        },
      });

      const claritMeta = result.providerMetadata?.clarit as Record<string, unknown>;
      expect(claritMeta?.snapshotSaved).toBe(false);
      expect(claritMeta?.snapshotSaveError).toContain('Network error');
    });
  });

  describe('restore-and-generate', () => {
    it('calls restore endpoint instead of chat/completions', async () => {
      const result = await model.doGenerate({
        prompt: [],
        providerOptions: {
          clarit: {
            conversationId: 'session-1',
            turnNumber: 1,
            restoreBeforeGenerate: true,
            continuationIds: [1, 2, 3],
            maxNewTokens: 64,
          },
        },
      });

      expect(baseModel.doGenerate).not.toHaveBeenCalled();
      expect(snapshotClient.restore).toHaveBeenCalledWith({
        conversation_id: 'session-1',
        turn_number: 1,
        branch_name: undefined,
        create_new_request: true,
        continuation_ids: [1, 2, 3],
        max_new_tokens: 64,
      });
      expect(result.content).toEqual([{ type: 'text', text: 'Blue is your favorite color.' }]);
    });

    it('auto-saves after restore-and-generate', async () => {
      const result = await model.doGenerate({
        prompt: [],
        providerOptions: {
          clarit: {
            conversationId: 'session-1',
            restoreBeforeGenerate: true,
            continuationIds: [1, 2, 3],
            maxNewTokens: 64,
            autoSaveSnapshot: true,
          },
        },
      });

      expect(snapshotClient.save).toHaveBeenCalledWith(
        expect.objectContaining({
          rid: 'restored-req-1',
          conversation_id: 'session-1',
        }),
      );

      const claritMeta = result.providerMetadata?.clarit as Record<string, unknown>;
      expect(claritMeta?.snapshotSaved).toBe(true);
    });

    it('throws ClaritValidationError without continuationIds', async () => {
      await expect(
        model.doGenerate({
          prompt: [],
          providerOptions: {
            clarit: {
              conversationId: 'session-1',
              restoreBeforeGenerate: true,
              maxNewTokens: 64,
            },
          },
        }),
      ).rejects.toThrow(ClaritValidationError);
    });

    it('throws ClaritValidationError without maxNewTokens', async () => {
      await expect(
        model.doGenerate({
          prompt: [],
          providerOptions: {
            clarit: {
              conversationId: 'session-1',
              restoreBeforeGenerate: true,
              continuationIds: [1, 2, 3],
            },
          },
        }),
      ).rejects.toThrow(ClaritValidationError);
    });

    it('throws ClaritValidationError without conversationId', async () => {
      await expect(
        model.doGenerate({
          prompt: [],
          providerOptions: {
            clarit: {
              restoreBeforeGenerate: true,
              continuationIds: [1, 2, 3],
              maxNewTokens: 64,
            },
          },
        }),
      ).rejects.toThrow(ClaritValidationError);
    });
  });

  // ─── Compatibility bridge ──────────────────────────────────────────────

  describe('compatibility mode (append-only bridge)', () => {
    it('uses fast-path when messages are append-only to snapshot', async () => {
      // snapshotClient has fill_ids=[1,2,3] and tokenizeChat returns [1,2,3,4,5]
      // so continuationIds = [4,5]
      const result = await model.doGenerate({
        prompt: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        ],
        providerOptions: {
          clarit: {
            conversationId: 'session-1',
            turnNumber: 1,
            autoSaveSnapshot: true,
            compatibilityMode: 'append-only',
            maxNewTokens: 64,
          },
        },
      });

      // Should NOT call base model (fast-path used)
      expect(baseModel.doGenerate).not.toHaveBeenCalled();

      // Should call tokenizeChat, getInfo, then restore
      expect(snapshotClient.tokenizeChat).toHaveBeenCalled();
      expect(snapshotClient.getInfo).toHaveBeenCalled();
      expect(snapshotClient.restore).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation_id: 'session-1',
          create_new_request: true,
          continuation_ids: [4, 5],
          max_new_tokens: 64,
        }),
      );

      // Diagnostics
      const meta = result.providerMetadata?.clarit as Record<string, unknown>;
      expect(meta?.compatibilityMode).toBe('append-only');
      expect(meta?.compatibilityResult).toBe('fast-path');
      expect(meta?.snapshotLookupHit).toBe(true);
      expect(meta?.tokenizationSource).toBe('server-chat-template');
      expect(meta?.reusedTokenCount).toBe(3);
      expect(meta?.continuationTokenCount).toBe(2);
    });

    it('falls back to stateless when prefix does not match', async () => {
      // Return token IDs that don't match the fill_ids prefix
      (snapshotClient.tokenizeChat as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        token_ids: [99, 100, 101], // completely different
        token_count: 3,
      });

      const result = await model.doGenerate({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'Different message' }] },
        ],
        providerOptions: {
          clarit: {
            conversationId: 'session-1',
            compatibilityMode: 'append-only',
            maxNewTokens: 64,
          },
        },
      });

      // Should fall back to base model
      expect(baseModel.doGenerate).toHaveBeenCalled();

      const meta = result.providerMetadata?.clarit as Record<string, unknown>;
      expect(meta?.compatibilityResult).toBe('fallback');
      expect(meta?.fallbackReason).toBe('prefix-mismatch');
    });

    it('falls back when no snapshot exists', async () => {
      (snapshotClient.getInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        message: 'Snapshot not found',
      });

      const result = await model.doGenerate({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        ],
        providerOptions: {
          clarit: {
            conversationId: 'session-new',
            compatibilityMode: 'append-only',
            maxNewTokens: 64,
          },
        },
      });

      expect(baseModel.doGenerate).toHaveBeenCalled();
      const meta = result.providerMetadata?.clarit as Record<string, unknown>;
      expect(meta?.compatibilityResult).toBe('fallback');
      expect(meta?.fallbackReason).toBe('no-snapshot');
      expect(meta?.snapshotLookupHit).toBe(false);
    });

    it('falls back when fill_ids is missing from snapshot', async () => {
      (snapshotClient.getInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        metadata: {
          conversation_id: 'session-1',
          turn_number: 1,
          // No fill_ids
          model_name: 'granite-4.0-h-small',
        },
      });

      const result = await model.doGenerate({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        ],
        providerOptions: {
          clarit: {
            conversationId: 'session-1',
            compatibilityMode: 'append-only',
            maxNewTokens: 64,
          },
        },
      });

      expect(baseModel.doGenerate).toHaveBeenCalled();
      const meta = result.providerMetadata?.clarit as Record<string, unknown>;
      expect(meta?.fallbackReason).toBe('fill-ids-missing');
    });

    it('falls back when conversationId is missing', async () => {
      const result = await model.doGenerate({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        ],
        providerOptions: {
          clarit: {
            compatibilityMode: 'append-only',
            maxNewTokens: 64,
          },
        },
      });

      expect(baseModel.doGenerate).toHaveBeenCalled();
      const meta = result.providerMetadata?.clarit as Record<string, unknown>;
      expect(meta?.fallbackReason).toBe('missing-conversation-id');
    });

    it('falls back when messages contain tool calls', async () => {
      const result = await model.doGenerate({
        prompt: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check.' },
              { type: 'tool-call', toolCallId: 'tc-1', toolName: 'search', args: '{}' },
            ],
          },
        ],
        providerOptions: {
          clarit: {
            conversationId: 'session-1',
            compatibilityMode: 'append-only',
            maxNewTokens: 64,
          },
        },
      });

      expect(baseModel.doGenerate).toHaveBeenCalled();
      const meta = result.providerMetadata?.clarit as Record<string, unknown>;
      expect(meta?.fallbackReason).toBe('unsupported-content');
    });

    it('falls back when tokenization fails', async () => {
      (snapshotClient.tokenizeChat as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Connection refused'),
      );

      const result = await model.doGenerate({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        ],
        providerOptions: {
          clarit: {
            conversationId: 'session-1',
            compatibilityMode: 'append-only',
            maxNewTokens: 64,
          },
        },
      });

      expect(baseModel.doGenerate).toHaveBeenCalled();
      const meta = result.providerMetadata?.clarit as Record<string, unknown>;
      expect(meta?.fallbackReason).toBe('tokenization-error');
    });

    it('auto-saves after fallback so next turn can attempt fast-path', async () => {
      (snapshotClient.getInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: false,
        message: 'Snapshot not found',
      });

      const result = await model.doGenerate({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
        ],
        providerOptions: {
          clarit: {
            conversationId: 'session-1',
            compatibilityMode: 'append-only',
            maxNewTokens: 64,
            autoSaveSnapshot: true,
          },
        },
      });

      // Auto-save should fire after the standard generation
      expect(snapshotClient.save).toHaveBeenCalled();
    });

    it('returns correct restore response content on fast-path', async () => {
      (snapshotClient.restore as ReturnType<typeof vi.fn>).mockResolvedValue({
        success: true,
        rid: 'compat-req-1',
        output_text: 'Your favorite color is blue.',
        output_ids: [101, 202, 303],
        token_count: 67,
      });

      const result = await model.doGenerate({
        prompt: [
          { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
        ],
        providerOptions: {
          clarit: {
            conversationId: 'session-1',
            compatibilityMode: 'append-only',
            maxNewTokens: 128,
          },
        },
      });

      expect(result.content).toEqual([
        { type: 'text', text: 'Your favorite color is blue.' },
      ]);
    });
  });
});
