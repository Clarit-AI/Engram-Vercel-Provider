/**
 * Unit tests for the Clarit snapshot client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaritSnapshotClient } from '../src/snapshots/snapshot-client.js';
import { ClaritSnapshotError } from '../src/errors.js';

function createMockFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(response),
  });
}

describe('ClaritSnapshotClient', () => {
  let client: ClaritSnapshotClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = createMockFetch({ success: true });
    client = new ClaritSnapshotClient({
      baseURL: 'http://localhost:30000',
      apiKey: 'test-key',
      fetch: mockFetch as unknown as typeof globalThis.fetch,
    });
  });

  // ── save ──────────────────────────────────────────────────────────

  describe('save', () => {
    it('sends correct request to /save_snapshot', async () => {
      mockFetch = createMockFetch({
        success: true,
        snapshot_id: 'snap-123',
        message: 'Snapshot saved',
      });
      client = new ClaritSnapshotClient({
        baseURL: 'http://localhost:30000',
        apiKey: 'test-key',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      });

      const result = await client.save({
        rid: 'req-1',
        conversation_id: 'chat-1',
        turn_number: 2,
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:30000/save_snapshot',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-key',
          },
          body: JSON.stringify({
            rid: 'req-1',
            conversation_id: 'chat-1',
            turn_number: 2,
          }),
        }),
      );
      expect(result.success).toBe(true);
      expect(result.snapshot_id).toBe('snap-123');
    });

    it('throws ClaritSnapshotError on success:false (HTTP 200)', async () => {
      mockFetch = createMockFetch({
        success: false,
        message: 'Error saving snapshot: no active request',
      });
      client = new ClaritSnapshotClient({
        baseURL: 'http://localhost:30000',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      });

      await expect(
        client.save({ rid: 'bad-rid', conversation_id: 'chat-1' }),
      ).rejects.toThrow(ClaritSnapshotError);
    });

    it('omits Authorization header when no apiKey', async () => {
      mockFetch = createMockFetch({ success: true });
      client = new ClaritSnapshotClient({
        baseURL: 'http://localhost:30000',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      });

      await client.save({ conversation_id: 'chat-1' });

      const callHeaders = mockFetch.mock.calls[0][1].headers;
      expect(callHeaders.Authorization).toBeUndefined();
    });
  });

  // ── list ──────────────────────────────────────────────────────────

  describe('list', () => {
    it('returns snapshot metadata array', async () => {
      const snapshots = [
        {
          conversation_id: 'chat-1',
          turn_number: 1,
          timestamp: 1712345678.0,
          token_count: 128,
        },
        {
          conversation_id: 'chat-1',
          turn_number: 2,
          timestamp: 1712345700.0,
          token_count: 256,
        },
      ];
      mockFetch = createMockFetch({ success: true, snapshots });
      client = new ClaritSnapshotClient({
        baseURL: 'http://localhost:30000',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      });

      const result = await client.list('chat-1');

      expect(result).toHaveLength(2);
      expect(result[0].turn_number).toBe(1);
      expect(result[1].token_count).toBe(256);
    });

    it('returns empty array for unknown conversation', async () => {
      mockFetch = createMockFetch({ success: true, snapshots: [] });
      client = new ClaritSnapshotClient({
        baseURL: 'http://localhost:30000',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      });

      const result = await client.list('unknown');
      expect(result).toEqual([]);
    });
  });

  // ── restore ───────────────────────────────────────────────────────

  describe('restore', () => {
    it('handles restore-and-generate response', async () => {
      mockFetch = createMockFetch({
        success: true,
        rid: 'restored-req-456',
        mamba_pool_idx: 7,
        message: 'Snapshot restored successfully',
        token_count: 128,
        output_ids: [101, 202, 303],
        output_text: 'Your favorite color is blue.',
      });
      client = new ClaritSnapshotClient({
        baseURL: 'http://localhost:30000',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      });

      const result = await client.restore({
        conversation_id: 'chat-1',
        create_new_request: true,
        continuation_ids: [1, 2, 3, 4],
        max_new_tokens: 80,
      });

      expect(result.success).toBe(true);
      expect(result.output_text).toBe('Your favorite color is blue.');
      expect(result.rid).toBe('restored-req-456');
    });

    it('returns failure response without throwing (allowNon2xx)', async () => {
      mockFetch = createMockFetch(
        {
          success: false,
          rid: null,
          message: 'Snapshot not found',
          output_text: null,
        },
        500,
      );
      client = new ClaritSnapshotClient({
        baseURL: 'http://localhost:30000',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      });

      const result = await client.restore({
        conversation_id: 'missing',
        create_new_request: true,
        continuation_ids: [1],
        max_new_tokens: 10,
      });

      expect(result.success).toBe(false);
    });
  });

  // ── delete ────────────────────────────────────────────────────────

  describe('delete', () => {
    it('sends delete request', async () => {
      mockFetch = createMockFetch({
        success: true,
        message: 'Snapshot deleted',
      });
      client = new ClaritSnapshotClient({
        baseURL: 'http://localhost:30000',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      });

      const result = await client.delete({
        conversation_id: 'chat-1',
        turn_number: 2,
      });

      expect(result.success).toBe(true);
    });
  });

  // ── error handling ────────────────────────────────────────────────

  describe('error handling', () => {
    it('throws on network error', async () => {
      mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      client = new ClaritSnapshotClient({
        baseURL: 'http://localhost:30000',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      });

      await expect(client.list('chat-1')).rejects.toThrow(
        ClaritSnapshotError,
      );
    });

    it('throws on invalid JSON response', async () => {
      mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('Invalid JSON')),
      });
      client = new ClaritSnapshotClient({
        baseURL: 'http://localhost:30000',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      });

      await expect(client.list('chat-1')).rejects.toThrow(
        ClaritSnapshotError,
      );
    });

    it('strips trailing slashes from baseURL', async () => {
      mockFetch = createMockFetch({ success: true, snapshots: [] });
      client = new ClaritSnapshotClient({
        baseURL: 'http://localhost:30000///',
        fetch: mockFetch as unknown as typeof globalThis.fetch,
      });

      await client.list('chat-1');
      expect(mockFetch.mock.calls[0][0]).toBe(
        'http://localhost:30000/list_snapshots',
      );
    });
  });
});
