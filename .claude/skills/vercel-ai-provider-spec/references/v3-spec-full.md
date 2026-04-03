# Language Model Specification V3 — Full Reference

Source: Vercel AI SDK custom provider documentation.

## Provider Entry Point

```ts
import {
  generateId,
  loadApiKey,
  withoutTrailingSlash,
} from '@ai-sdk/provider-utils';
import { ProviderV3 } from '@ai-sdk/provider';
import { CustomChatLanguageModel } from './custom-chat-language-model';

interface CustomProvider extends ProviderV3 {
  (modelId: string, settings?: CustomChatSettings): CustomChatLanguageModel;
  languageModel(
    modelId: string,
    settings?: CustomChatSettings,
  ): CustomChatLanguageModel;
}

interface CustomProviderSettings {
  baseURL?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

function createCustom(options: CustomProviderSettings = {}): CustomProvider {
  const createChatModel = (
    modelId: string,
    settings: CustomChatSettings = {},
  ) =>
    new CustomChatLanguageModel(modelId, settings, {
      provider: 'custom',
      baseURL:
        withoutTrailingSlash(options.baseURL) ?? 'https://api.custom.ai/v1',
      headers: () => ({
        Authorization: `Bearer ${loadApiKey({
          apiKey: options.apiKey,
          environmentVariableName: 'CUSTOM_API_KEY',
          description: 'Custom Provider',
        })}`,
        ...options.headers,
      }),
      generateId: options.generateId ?? generateId,
    });

  const provider = function (modelId: string, settings?: CustomChatSettings) {
    if (new.target) {
      throw new Error(
        'The model factory function cannot be called with the new keyword.',
      );
    }
    return createChatModel(modelId, settings);
  };

  provider.languageModel = createChatModel;
  return provider as CustomProvider;
}

const custom = createCustom();
```

## Language Model Implementation

```ts
import { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';
import { postJsonToApi } from '@ai-sdk/provider-utils';

class CustomChatLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = 'V3';
  readonly provider: string;
  readonly modelId: string;

  constructor(
    modelId: string,
    settings: CustomChatSettings,
    config: CustomChatConfig,
  ) {
    this.provider = config.provider;
    this.modelId = modelId;
  }

  private getArgs(options: LanguageModelV3CallOptions) {
    const warnings: SharedV3Warning[] = [];
    const messages = this.convertToProviderMessages(options.prompt);
    const tools = options.tools
      ? this.prepareTools(options.tools, options.toolChoice)
      : undefined;

    const body = {
      model: this.modelId,
      messages,
      temperature: options.temperature,
      max_tokens: options.maxOutputTokens,
      stop: options.stopSequences,
      tools,
    };

    return { args: body, warnings };
  }

  async doGenerate(options: LanguageModelV3CallOptions) {
    const { args, warnings } = this.getArgs(options);

    const response = await postJsonToApi({
      url: `${this.config.baseURL}/chat/completions`,
      headers: this.config.headers(),
      body: args,
      abortSignal: options.abortSignal,
    });

    const content: LanguageModelV3Content[] = [];

    if (response.choices[0].message.content) {
      content.push({
        type: 'text',
        text: response.choices[0].message.content,
      });
    }

    if (response.choices[0].message.tool_calls) {
      for (const toolCall of response.choices[0].message.tool_calls) {
        content.push({
          type: 'tool-call',
          toolCallType: 'function',
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          args: JSON.stringify(toolCall.function.arguments),
        });
      }
    }

    return {
      content,
      finishReason: this.mapFinishReason(response.choices[0].finish_reason),
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        totalTokens: response.usage?.total_tokens,
      },
      request: { body: args },
      response: { body: response },
      warnings,
    };
  }

  async doStream(options: LanguageModelV3CallOptions) {
    const { args, warnings } = this.getArgs(options);

    const response = await fetch(`${this.config.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        ...this.config.headers(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...args, stream: true }),
      signal: options.abortSignal,
    });

    const stream = response
      .body!.pipeThrough(new TextDecoderStream())
      .pipeThrough(this.createParser())
      .pipeThrough(this.createTransformer(warnings));

    return { stream, warnings };
  }

  get supportedUrls() {
    return {
      'image/*': [/^https:\/\/example\.com\/images\/.*/],
    };
  }
}
```

## Message Conversion

```ts
private convertToProviderMessages(prompt: LanguageModelV3Prompt) {
  return prompt.map((message) => {
    switch (message.role) {
      case 'system':
        return { role: 'system', content: message.content };

      case 'user':
        return {
          role: 'user',
          content: message.content.map((part) => {
            switch (part.type) {
              case 'text':
                return { type: 'text', text: part.text };
              case 'file':
                return {
                  type: 'image_url',
                  image_url: {
                    url: this.convertFileToUrl(part.data),
                  },
                };
              default:
                throw new Error(`Unsupported part type: ${part.type}`);
            }
          }),
        };

      case 'assistant':
        return this.convertAssistantMessage(message);

      case 'tool':
        return this.convertToolMessage(message);

      default:
        throw new Error(`Unsupported message role: ${message.role}`);
    }
  });
}
```

## Streaming Transformer

```ts
private createTransformer(warnings: SharedV3Warning[]) {
  let isFirstChunk = true;

  return new TransformStream<ParsedChunk, LanguageModelV3StreamPart>({
    async transform(chunk, controller) {
      if (isFirstChunk) {
        controller.enqueue({ type: 'stream-start', warnings });
        isFirstChunk = false;
      }

      if (chunk.choices?.[0]?.delta?.content) {
        controller.enqueue({
          type: 'text',
          text: chunk.choices[0].delta.content,
        });
      }

      if (chunk.choices?.[0]?.delta?.tool_calls) {
        for (const toolCall of chunk.choices[0].delta.tool_calls) {
          controller.enqueue({
            type: 'tool-call-delta',
            toolCallType: 'function',
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            argsTextDelta: toolCall.function.arguments,
          });
        }
      }

      if (chunk.choices?.[0]?.finish_reason) {
        controller.enqueue({
          type: 'finish',
          finishReason: this.mapFinishReason(chunk.choices[0].finish_reason),
          usage: {
            inputTokens: chunk.usage?.prompt_tokens,
            outputTokens: chunk.usage?.completion_tokens,
            totalTokens: chunk.usage?.total_tokens,
          },
        });
      }
    },
  });
}
```

## Error Handling

```ts
import {
  APICallError,
  InvalidResponseDataError,
  TooManyRequestsError,
} from '@ai-sdk/provider';

private handleError(error: unknown): never {
  if (error instanceof Response) {
    const status = error.status;

    if (status === 429) {
      throw new TooManyRequestsError({
        cause: error,
        retryAfter: this.getRetryAfter(error),
      });
    }

    throw new APICallError({
      statusCode: status,
      statusText: error.statusText,
      cause: error,
      isRetryable: status >= 500 && status < 600,
    });
  }

  throw error;
}
```

## Content Types Reference

### Text Content
```ts
type LanguageModelV3Text = {
  type: 'text';
  text: string;
};
```

### Tool Calls
```ts
type LanguageModelV3ToolCall = {
  type: 'tool-call';
  toolCallType: 'function';
  toolCallId: string;
  toolName: string;
  args: string;
};
```

### File Generation
```ts
type LanguageModelV3File = {
  type: 'file';
  mediaType: string;
  data: string | Uint8Array;
};
```

### Reasoning
```ts
type LanguageModelV3Reasoning = {
  type: 'reasoning';
  text: string;
  providerMetadata?: SharedV2ProviderMetadata;
};
```

### Sources
```ts
type LanguageModelV3Source = {
  type: 'source';
  sourceType: 'url';
  id: string;
  url: string;
  title?: string;
  providerMetadata?: SharedV2ProviderMetadata;
};
```

## Usage Tracking

```ts
type LanguageModelV3Usage = {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  totalTokens: number | undefined;
  reasoningTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
};
```

## Tools

### Function Tools
```ts
type LanguageModelV3FunctionTool = {
  type: 'function';
  name: string;
  description?: string;
  parameters: JSONSchema7;
};
```

### Provider-Defined Client Tools
```ts
export type LanguageModelV3ProviderClientDefinedTool = {
  type: 'provider-defined-client';
  id: string;
  name: string;
  args: Record<string, unknown>;
};
```

Tool choice: `'auto' | 'none' | 'required' | { type: 'tool', toolName: string }`

## Native URL Support

Providers declare URL patterns they can access directly:

```ts
supportedUrls: {
  'image/*': [/^https:\/\/cdn\.example\.com\/.*/],
  'application/pdf': [/^https:\/\/docs\.example\.com\/.*/],
}
```

## Reference Implementations

- [Mistral provider](https://github.com/vercel/ai/tree/main/packages/mistral) — recommended reference
- [Provider utilities](https://github.com/vercel/ai/tree/main/packages/provider-utils)
- [Language Model Specification V3 source](https://github.com/vercel/ai/tree/main/packages/provider/src/language-model/v3)
