---
name: vercel-ai-provider-spec
description: Reference for the Vercel AI SDK Language Model Specification V4. This skill should be used when implementing or modifying a custom provider for the Vercel AI SDK, understanding the LanguageModelV4 interface, mapping prompts to provider format, implementing streaming, or handling errors in a provider context. Also covers the upgrade path from V1 to V4.
---

# Vercel AI SDK — Language Model Specification V4

## Purpose

This skill provides the Language Model Specification V4 reference for building custom providers compatible with the Vercel AI SDK (`ai` package >=4.0.0). Use it when working on `@clarit.ai/vercel-ai-provider` or any custom AI SDK provider implementation.

## When to Use

- Implementing or modifying `ClaritChatModel` (or any `LanguageModelV4` implementation)
- Upgrading from V1 to V4 spec
- Mapping AI SDK prompt structures to provider-specific API formats
- Implementing `doGenerate` or `doStream` methods
- Adding tool call support, streaming parts, or provider options
- Debugging provider-level errors or warnings

## Current State

The `ClaritChatModel` currently implements **V1** (`specificationVersion: 'v1'`). V4 is the latest spec. The SDK provides backward compatibility adapters (`asLanguageModelV4`) that proxy older versions, but upgrading natively gives access to new features.

## V4 Architecture

### LanguageModelV4 Interface

```ts
type LanguageModelV4 = {
  readonly specificationVersion: 'v4';
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls:
    | PromiseLike<Record<string, RegExp[]>>
    | Record<string, RegExp[]>;

  doGenerate(options: LanguageModelV4CallOptions): PromiseLike<LanguageModelV4GenerateResult>;
  doStream(options: LanguageModelV4CallOptions): PromiseLike<LanguageModelV4StreamResult>;
};
```

### ProviderV4 Interface

```ts
interface ProviderV4 {
  readonly specificationVersion: 'v4';
  languageModel(modelId: string): LanguageModelV4;
  embeddingModel(modelId: string): EmbeddingModelV4;
  imageModel(modelId: string): ImageModelV4;
  transcriptionModel?(modelId: string): TranscriptionModelV4;
  speechModel?(modelId: string): SpeechModelV4;
  rerankingModel?(modelId: string): RerankingModelV4;
  files?(): FilesV4;
}
```

### V4 Call Options (key additions vs V1)

| Option | Type | Notes |
|--------|------|-------|
| `prompt` | `LanguageModelV4Prompt` | Standardized message array |
| `maxOutputTokens` | `number?` | Max generation tokens |
| `temperature` | `number?` | Sampling temperature |
| `stopSequences` | `string[]?` | Stop strings |
| `topP` | `number?` | **New in V4** — nucleus sampling |
| `topK` | `number?` | **New in V4** — top-K sampling |
| `presencePenalty` | `number?` | **New in V4** |
| `frequencyPenalty` | `number?` | **New in V4** |
| `responseFormat` | `{ type: 'text' \| 'json', schema?, name?, description? }` | **New in V4** |
| `seed` | `number?` | **New in V4** — deterministic sampling |
| `reasoning` | `'provider-default' \| 'none' \| 'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh'` | **New in V4** |
| `tools` | `Array<FunctionTool \| ProviderTool>` | Tool definitions |
| `toolChoice` | `LanguageModelV4ToolChoice` | Tool selection mode |
| `includeRawChunks` | `boolean?` | **New in V4** — stream raw chunks |
| `abortSignal` | `AbortSignal?` | Cancellation |
| `headers` | `Record<string, string \| undefined>?` | **New in V4** — per-call headers |
| `providerOptions` | `SharedV4ProviderOptions?` | Provider-specific passthrough |

### V4 Generate Result

```ts
type LanguageModelV4GenerateResult = {
  content: Array<LanguageModelV4Content>;
  finishReason: LanguageModelV4FinishReason;
  usage: LanguageModelV4Usage;
  providerMetadata?: SharedV4ProviderMetadata;
  request?: { body?: unknown };
  response?: LanguageModelV4ResponseMetadata & {
    headers?: SharedV4Headers;
    body?: unknown;
  };
  warnings: Array<SharedV4Warning>;
};
```

### V4 Stream Result

```ts
type LanguageModelV4StreamResult = {
  stream: ReadableStream<LanguageModelV4StreamPart>;
  request?: { body?: unknown };
  response?: { headers?: SharedV4Headers };
};
```

### V4 Stream Parts

Typed events in order:

1. `stream-start` — initial event with warnings
2. Content events — `text`, `file`, `reasoning`, `source`, `tool-call`
3. `tool-call-delta` — incremental tool argument updates
4. `response-metadata` — model info
5. `finish` — usage stats and finish reason
6. `error` — can occur at any point

Finish reasons: `'stop'` | `'length'` | `'content-filter'` | `'tool-calls'` | `'error'` | `'other'`

### V4 Content Types

| Type | Key Fields |
|------|-----------|
| `text` | `text: string` |
| `tool-call` | `toolCallId`, `toolName`, `args: string` |
| `file` | `mediaType: string`, `data: string \| Uint8Array` |
| `reasoning` | `text: string`, optional `providerMetadata` |
| `source` | `sourceType: 'url'`, `url`, `title` |

### supportedUrls (Required in V4)

Declares URL patterns the provider handles natively (avoids downloading):

```ts
supportedUrls: {
  'image/*': [/^https:\/\/cdn\.clarit\.ai\/.*/],
  'application/pdf': [/^https:\/\/docs\.clarit\.ai\/.*/],
}
```

## Upgrade Path: V1 → V4

### What Changes

| Aspect | V1 (current) | V4 (target) |
|--------|-------------|-------------|
| `specificationVersion` | `'v1'` | `'v4'` |
| `supportedUrls` | optional | **required** |
| Call options | basic set | adds `topP`, `topK`, `reasoning`, `responseFormat`, `seed`, `headers` |
| Content types | text, tool-call | adds `file`, `reasoning`, `source` |
| Provider interface | `LanguageModelV1` | includes `files()`, `speechModel()`, etc. |
| Provider metadata | `Record<string, JSONValue>` | `SharedV4ProviderMetadata` |

### Backward Compatibility

The SDK provides adapters for older specs:

```ts
import { asLanguageModelV4 } from 'ai';
// Proxies V1/V2/V3 models as V4
const v4Model = asLanguageModelV4(v1Model);
```

This means existing V1 providers work with V4 consumers via proxy, but native V4 implementation is preferred for new features.

## Error Handling

Standardized error types from `@ai-sdk/provider`:

- `APICallError` — HTTP errors with `statusCode`, `isRetryable`
- `InvalidResponseDataError` — malformed responses
- `TooManyRequestsError` — 429 with `retryAfter`

## References

See `references/v3-spec-full.md` for the step-by-step implementation guide (V3 patterns still apply to V4 — the structure is the same, just with more option fields and the `supportedUrls` requirement).

See `references/v4-spec-types.md` for the complete V4 type definitions from the Vercel AI SDK source.