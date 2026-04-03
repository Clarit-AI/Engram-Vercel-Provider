# V4 Spec Types — Source from Vercel AI SDK

Fetched from `github.com/vercel/ai` `packages/provider/src/language-model/v4/`.

## LanguageModelV4

```ts
import { LanguageModelV4CallOptions } from './language-model-v4-call-options';
import { LanguageModelV4GenerateResult } from './language-model-v4-generate-result';
import { LanguageModelV4StreamResult } from './language-model-v4-stream-result';

type LanguageModelV4 = {
  readonly specificationVersion: 'v4';
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls:
    | PromiseLike<Record<string, RegExp[]>>
    | Record<string, RegExp[]>;

  doGenerate(
    options: LanguageModelV4CallOptions,
  ): PromiseLike<LanguageModelV4GenerateResult>;

  doStream(
    options: LanguageModelV4CallOptions,
  ): PromiseLike<LanguageModelV4StreamResult>;
};
```

## LanguageModelV4CallOptions

```ts
import { JSONSchema7 } from 'json-schema';
import { SharedV4ProviderOptions } from '../../shared/v4/shared-v4-provider-options';
import { LanguageModelV4FunctionTool } from './language-model-v4-function-tool';
import { LanguageModelV4Prompt } from './language-model-v4-prompt';
import { LanguageModelV4ProviderTool } from './language-model-v4-provider-tool';
import { LanguageModelV4ToolChoice } from './language-model-v4-tool-choice';

type LanguageModelV4CallOptions = {
  prompt: LanguageModelV4Prompt;
  maxOutputTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  responseFormat?:
    | { type: 'text' }
    | {
        type: 'json';
        schema?: JSONSchema7;
        name?: string;
        description?: string;
      };
  seed?: number;
  tools?: Array<LanguageModelV4FunctionTool | LanguageModelV4ProviderTool>;
  toolChoice?: LanguageModelV4ToolChoice;
  includeRawChunks?: boolean;
  abortSignal?: AbortSignal;
  headers?: Record<string, string | undefined>;
  reasoning?:
    | 'provider-default'
    | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh';
  providerOptions?: SharedV4ProviderOptions;
};
```

## LanguageModelV4GenerateResult

```ts
import { SharedV4Headers, SharedV4Warning } from '../../shared';
import { SharedV4ProviderMetadata } from '../../shared/v4/shared-v4-provider-metadata';
import { LanguageModelV4Content } from './language-model-v4-content';
import { LanguageModelV4FinishReason } from './language-model-v4-finish-reason';
import { LanguageModelV4ResponseMetadata } from './language-model-v4-response-metadata';
import { LanguageModelV4Usage } from './language-model-v4-usage';

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

## LanguageModelV4StreamResult

```ts
import { SharedV4Headers } from '../../shared';
import { LanguageModelV4StreamPart } from './language-model-v4-stream-part';

type LanguageModelV4StreamResult = {
  stream: ReadableStream<LanguageModelV4StreamPart>;
  request?: { body?: unknown };
  response?: { headers?: SharedV4Headers };
};
```

## ProviderV4

```ts
import { EmbeddingModelV4 } from '../../embedding-model/v4/embedding-model-v4';
import { FilesV4 } from '../../files/v4/files-v4';
import { ImageModelV4 } from '../../image-model/v4/image-model-v4';
import { LanguageModelV4 } from '../../language-model/v4/language-model-v4';
import { RerankingModelV4 } from '../../reranking-model/v4/reranking-model-v4';
import { SpeechModelV4 } from '../../speech-model/v4/speech-model-v4';
import { TranscriptionModelV4 } from '../../transcription-model/v4/transcription-model-v4';

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

## Backward Compatibility Adapter

```ts
// packages/ai/src/model/as-language-model-v4.ts
import {
  LanguageModelV2,
  LanguageModelV3,
  LanguageModelV4,
} from '@ai-sdk/provider';
import { asLanguageModelV3 } from './as-language-model-v3';

function asLanguageModelV4(
  model: LanguageModelV2 | LanguageModelV3 | LanguageModelV4,
): LanguageModelV4 {
  if (model.specificationVersion === 'v4') {
    return model;
  }

  // first convert v2 to v3, then proxy v3 as v4:
  const v3Model =
    model.specificationVersion === 'v2' ? asLanguageModelV3(model) : model;

  return new Proxy(v3Model, {
    get(target, prop: keyof LanguageModelV3) {
      if (prop === 'specificationVersion') return 'v4';
      return target[prop];
    },
  }) as unknown as LanguageModelV4;
}
```
