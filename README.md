# @clarit.ai/vercel-ai-provider

### Vercel AI SDK models that remember.

[![Built on SGLang](https://img.shields.io/badge/built%20on-SGLang-blue)](https://github.com/sgl-project/sglang)
[![Vercel AI SDK](https://img.shields.io/badge/AI--SDK-v4-black)](https://sdk.vercel.ai)

Standard LLM providers treat model state as disposable. Every new message re-reads the entire conversation history from scratch, costing you time and tokens.

**Clarit (Engram) changes the rules.** 

This provider for the [Vercel AI SDK](https://sdk.vercel.ai) turns model state into a durable asset. Save conversation state to disk and restore it in ~2ms. Skip the prefill, slash token costs by 94%, and pick up exactly where you left off.

---

## Installation

```bash
npm install @clarit.ai/vercel-ai-provider ai
```

## Features

- **Drop-in Persistence**: Wrap any OpenAI-compatible Mamba/hybrid model.
- **Auto-Save Snapshots**: Automatically persist conversation state to the Engram 3-tier hierarchy (VRAM/RAM/Disk).
- **Restore-and-Generate**: Perform inference by restoring state directly, bypassing standard `/v1/chat/completions` prefill overhead.
- **Snapshot Management**: Direct TypeScript client for listing, querying, and deleting conversation checkpoints.

## Quick Start

```typescript
import { createClarit } from '@clarit.ai/vercel-ai-provider';
import { generateText } from 'ai';

const clarit = createClarit({
  baseURL: 'http://your-engram-server:30000',
});

// 1. Initial Turn: Save the context
const { text } = await generateText({
  model: clarit('granite-4.0-h-small'),
  messages: [{ role: 'user', content: 'My name is Alice.' }],
  providerOptions: {
    clarit: {
      conversationId: 'session-123',
      turnNumber: 1,
      autoSaveSnapshot: true,
    },
  },
});

// 2. Future Session: Instant Recall
// Restores Alice's state in ~2ms, skipping re-reading Turn 1.
const { text: recalled } = await generateText({
  model: clarit('granite-4.0-h-small'),
  messages: [], // History is restored from state, not re-read from text
  providerOptions: {
    clarit: {
      conversationId: 'session-123',
      turnNumber: 1,
      restoreBeforeGenerate: true,
      continuationIds: [5812, 1072, 30], // Tokenized "What is my name?"
      maxNewTokens: 64,
    },
  },
});
```

## Provider Options

| Option | Type | Description |
|--------|------|-------------|
| `conversationId` | `string` | Stable ID for grouping conversation snapshots. |
| `turnNumber` | `number` | The turn index to save to or restore from. |
| `autoSaveSnapshot` | `boolean` | Save state after generation completes (best-effort). |
| `restoreBeforeGenerate` | `boolean` | Mode: Restore state -> Append tokens -> Generate. |
| `continuationIds` | `number[]` | Token IDs for the new turn (required for restore mode). |
| `maxNewTokens` | `number` | Max tokens to generate in restore mode. |

## Snapshot Management

Access the Engram management API directly via `clarit.snapshots`:

```typescript
const snapshots = await clarit.snapshots.list('conversation-123');
console.log(`Found ${snapshots.length} checkpoints.`);

await clarit.snapshots.delete({
  conversation_id: 'conversation-123',
  turn_number: 1
});
```

## Built-in Agent Skills

This repo ships Claude Code / agent skills in `.claude/skills/` that give AI assistants working knowledge of the systems this provider touches — no extra setup required:

| Skill | Purpose |
|-------|---------|
| `vercel-ai-provider-spec` | Vercel AI SDK Language Model spec (V3/V4), type reference, and upgrade patterns |
| `engram-sglang` | Engram server architecture, snapshot API contract, server flags, model compatibility matrix |

If you're using Claude Code, these are loaded automatically. For other agents, the Markdown content in each `SKILL.md` and its `references/` directory is designed to be consumable as-is.

## License

Apache-2.0
