/**
 * Unit tests for the append-only compatibility bridge pure functions.
 */
import { describe, it, expect } from 'vitest';
import {
  isAppendOnly,
  hasUnsupportedContent,
} from '../src/compatibility.js';

// ─── isAppendOnly ──────────────────────────────────────────────────────────

describe('isAppendOnly', () => {
  it('returns isAppend=true when fill_ids is an exact prefix', () => {
    const result = isAppendOnly([1, 2, 3], [1, 2, 3, 4, 5]);
    expect(result.isAppend).toBe(true);
    expect(result.continuationIds).toEqual([4, 5]);
  });

  it('returns isAppend=false when fill_ids is not a prefix', () => {
    const result = isAppendOnly([1, 2, 3], [1, 2, 99, 4, 5]);
    expect(result.isAppend).toBe(false);
    expect(result.continuationIds).toBeUndefined();
  });

  it('returns isAppend=false when fill_ids is longer than full token IDs', () => {
    const result = isAppendOnly([1, 2, 3, 4, 5], [1, 2, 3]);
    expect(result.isAppend).toBe(false);
    expect(result.continuationIds).toBeUndefined();
  });

  it('returns isAppend=false when fill_ids is empty', () => {
    const result = isAppendOnly([], [1, 2, 3]);
    expect(result.isAppend).toBe(false);
    expect(result.continuationIds).toBeUndefined();
  });

  it('returns isAppend=false when both arrays are empty', () => {
    const result = isAppendOnly([], []);
    expect(result.isAppend).toBe(false);
    expect(result.continuationIds).toBeUndefined();
  });

  it('returns isAppend=false when arrays are identical (no delta)', () => {
    const result = isAppendOnly([1, 2, 3], [1, 2, 3]);
    expect(result.isAppend).toBe(false);
    expect(result.continuationIds).toBeUndefined();
  });

  it('returns isAppend=false when first element differs', () => {
    const result = isAppendOnly([0, 2, 3], [1, 2, 3, 4]);
    expect(result.isAppend).toBe(false);
    expect(result.continuationIds).toBeUndefined();
  });

  it('returns isAppend=false when last prefix element differs', () => {
    const result = isAppendOnly([1, 2, 99], [1, 2, 3, 4]);
    expect(result.isAppend).toBe(false);
    expect(result.continuationIds).toBeUndefined();
  });

  it('handles single-element fill_ids', () => {
    const result = isAppendOnly([1], [1, 2, 3]);
    expect(result.isAppend).toBe(true);
    expect(result.continuationIds).toEqual([2, 3]);
  });

  it('handles large arrays', () => {
    const fillIds = Array.from({ length: 4000 }, (_, i) => i);
    const fullIds = [...fillIds, 4000, 4001, 4002];
    const result = isAppendOnly(fillIds, fullIds);
    expect(result.isAppend).toBe(true);
    expect(result.continuationIds).toEqual([4000, 4001, 4002]);
  });
});

// ─── hasUnsupportedContent ──────────────────────────────────────────────────

describe('hasUnsupportedContent', () => {
  it('returns false for text-only user messages', () => {
    const prompt = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
    ];
    expect(hasUnsupportedContent(prompt)).toBe(false);
  });

  it('returns false for system message with string content', () => {
    const prompt = [
      { role: 'system', content: 'You are helpful.' },
    ];
    expect(hasUnsupportedContent(prompt)).toBe(false);
  });

  it('returns false for mixed system + user + assistant text messages', () => {
    const prompt = [
      { role: 'system', content: 'You are helpful.' },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Hello' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hi there!' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'How are you?' }],
      },
    ];
    expect(hasUnsupportedContent(prompt)).toBe(false);
  });

  it('returns true for tool-call content', () => {
    const prompt = [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          { type: 'tool-call', toolCallId: 'tc-1', toolName: 'search', args: '{}' },
        ],
      },
    ];
    expect(hasUnsupportedContent(prompt)).toBe(true);
  });

  it('returns true for tool-result content', () => {
    const prompt = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'tc-1',
            toolName: 'search',
            result: 'found',
          },
        ],
      },
    ];
    expect(hasUnsupportedContent(prompt)).toBe(true);
  });

  it('returns true for file content parts', () => {
    const prompt = [
      {
        role: 'user',
        content: [{ type: 'file', mediaType: 'image/png', data: 'base64...' }],
      },
    ];
    expect(hasUnsupportedContent(prompt)).toBe(true);
  });

  it('returns true for reasoning content parts', () => {
    const prompt = [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'Let me think...' }],
      },
    ];
    expect(hasUnsupportedContent(prompt)).toBe(true);
  });

  it('returns true for empty prompt array', () => {
    expect(hasUnsupportedContent([])).toBe(true);
  });
});
