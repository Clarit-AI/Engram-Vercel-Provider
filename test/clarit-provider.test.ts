/**
 * Unit tests for the Clarit provider factory and ClaritChatModel.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClarit } from '../src/clarit-provider.js';
import { ClaritChatModel } from '../src/clarit-chat-model.js';
import { ClaritSnapshotClient } from '../src/snapshots/snapshot-client.js';
import { ClaritValidationError } from '../src/errors.js';
import type { LanguageModelV1 } from '@ai-sdk/provider';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createMockBaseModel(): LanguageModelV1 {
  return {
    specificationVersion: 'v1',
    provider: 'clarit.chat',
    modelId: 'granite-4.0-h-small',
    defaultObjectGenerationMode: undefined,
    doGenerate: vi.fn().mockResolvedValue({
      text: 'Hello from Granite!',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 5 },
      rawCall: { rawPrompt: [], rawSettings: {} },
      rawResponse: { headers: undefined, id: 'req-abc' },
      warnings: [],
    }),
    doStream: vi.fn().mockResolvedValue({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'text-delta', textDelta: 'Hello' });
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            usage: { promptTokens: 10, completionTokens: 5 },
          });
          controller.close();
        },
      }),
      rawCall: { rawPrompt: [], rawSettings: {} },
      rawResponse: { headers: undefined },
      warnings: [],
    }),
  };
}

function createMockSnapshotClient() {
  return {
    save: vi.fn().mockResolvedValue({
      success: true,
      snapshot_id: 'snap-001',
    }),
    list: vi.fn().mockResolvedValue([]),
    getInfo: vi.fn().mockResolvedValue({ success: true }),
    restore: vi.fn().mockResolvedValue({
      success: true,
      rid: 'restored-req-1',
      output_text: 'Blue is your favorite color.',
      output_ids: [101, 202],
      token_count: 64,
    }),
    delete: vi.fn().mockResolvedValue({ success: true }),
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
  let baseModel: LanguageModelV1;
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
        inputFormat: 'messages',
        mode: { type: 'regular' },
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      });

      expect(baseModel.doGenerate).toHaveBeenCalled();
      expect(result.text).toBe('Hello from Granite!');
    });

    it('does not call snapshot client', async () => {
      await model.doGenerate({
        inputFormat: 'messages',
        mode: { type: 'regular' },
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      });

      expect(snapshotClient.save).not.toHaveBeenCalled();
    });
  });

  describe('auto-save snapshot', () => {
    it('saves snapshot after generation', async () => {
      const result = await model.doGenerate({
        inputFormat: 'messages',
        mode: { type: 'regular' },
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        providerOptions: {
          clarit: {
            conversationId: 'session-1',
            turnNumber: 1,
            autoSaveSnapshot: true,
          },
        },
      } as Record<string, unknown> as Parameters<typeof model.doGenerate>[0]);

      expect(snapshotClient.save).toHaveBeenCalledWith({
        rid: 'req-abc', // rid extracted from rawResponse.id
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
        inputFormat: 'messages',
        mode: { type: 'regular' },
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        providerOptions: {
          clarit: {
            conversationId: 'session-1',
            autoSaveSnapshot: true,
          },
        },
      } as Record<string, unknown> as Parameters<typeof model.doGenerate>[0]);

      const claritMeta = result.providerMetadata?.clarit as Record<string, unknown>;
      expect(claritMeta?.snapshotSaved).toBe(false);
      expect(claritMeta?.snapshotSaveError).toContain('Network error');
    });
  });

  describe('restore-and-generate', () => {
    it('calls restore endpoint instead of chat/completions', async () => {
      const result = await model.doGenerate({
        inputFormat: 'messages',
        mode: { type: 'regular' },
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
      } as Record<string, unknown> as Parameters<typeof model.doGenerate>[0]);

      expect(baseModel.doGenerate).not.toHaveBeenCalled();
      expect(snapshotClient.restore).toHaveBeenCalledWith({
        conversation_id: 'session-1',
        turn_number: 1,
        branch_name: undefined,
        create_new_request: true,
        continuation_ids: [1, 2, 3],
        max_new_tokens: 64,
      });
      expect(result.text).toBe('Blue is your favorite color.');
    });

    it('auto-saves after restore-and-generate', async () => {
      const result = await model.doGenerate({
        inputFormat: 'messages',
        mode: { type: 'regular' },
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
      } as Record<string, unknown> as Parameters<typeof model.doGenerate>[0]);

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
          inputFormat: 'messages',
          mode: { type: 'regular' },
          prompt: [],
          providerOptions: {
            clarit: {
              conversationId: 'session-1',
              restoreBeforeGenerate: true,
              maxNewTokens: 64,
            },
          },
        } as Record<string, unknown> as Parameters<typeof model.doGenerate>[0]),
      ).rejects.toThrow(ClaritValidationError);
    });

    it('throws ClaritValidationError without maxNewTokens', async () => {
      await expect(
        model.doGenerate({
          inputFormat: 'messages',
          mode: { type: 'regular' },
          prompt: [],
          providerOptions: {
            clarit: {
              conversationId: 'session-1',
              restoreBeforeGenerate: true,
              continuationIds: [1, 2, 3],
            },
          },
        } as Record<string, unknown> as Parameters<typeof model.doGenerate>[0]),
      ).rejects.toThrow(ClaritValidationError);
    });

    it('throws ClaritValidationError without conversationId', async () => {
      await expect(
        model.doGenerate({
          inputFormat: 'messages',
          mode: { type: 'regular' },
          prompt: [],
          providerOptions: {
            clarit: {
              restoreBeforeGenerate: true,
              continuationIds: [1, 2, 3],
              maxNewTokens: 64,
            },
          },
        } as Record<string, unknown> as Parameters<typeof model.doGenerate>[0]),
      ).rejects.toThrow(ClaritValidationError);
    });
  });
});
