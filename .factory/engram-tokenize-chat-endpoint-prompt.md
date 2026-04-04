# Engram Agent Prompt: Implement `POST /tokenize_chat` Endpoint

## Objective

Add a new `POST /tokenize_chat` HTTP endpoint to the Engram server that accepts OpenAI-format `messages[]` and returns token IDs after applying the server's chat template. This endpoint is the critical dependency for the Vercel AI SDK provider's "append-only compatibility bridge" feature.

## Context

The Engram Vercel AI SDK provider needs to compare incoming messages against snapshot `fill_ids` to detect append-only continuations. To avoid duplicating tokenizer+chat-template logic in JavaScript, the provider will call this endpoint to get authoritative token IDs from the server.

**This endpoint must produce identical token IDs to what `serving_chat.py` produces when it processes `/v1/chat/completions` requests.** Any divergence means the compatibility bridge's prefix-matching will fail incorrectly.

## Required Endpoint

### `POST /tokenize_chat`

**Request:**

```json
{
  "messages": [
    {"role": "system", "content": "You are helpful."},
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi there!"},
    {"role": "user", "content": "What is my favorite color?"}
  ],
  "add_generation_prompt": true
}
```

**Response (success):**

```json
{
  "success": true,
  "token_ids": [1, 345, 678, 910, 112, 134, 156, 178, 190],
  "token_count": 9,
  "chat_template_name": "granite-chat"
}
```

**Response (error):**

```json
{
  "success": false,
  "message": "Messages array cannot be empty"
}
```

### Fields

- `messages` (required): Array of OpenAI-format message objects with `role` and `content`. System, user, and assistant roles supported. Tool messages and multimodal content may be rejected in v1.
- `add_generation_prompt` (optional, default `true`): Whether to append the generation prompt (assistant turn prefix) after the messages. Must match the behavior of `serving_chat.py`.
- Response `token_ids`: Array of integer token IDs.
- Response `token_count`: Length of `token_ids`.
- Response `chat_template_name`: Name or identifier of the chat template used (diagnostic).

### Validation

- `messages` must be a non-empty array
- Each message must have `role` (string) and `content` (string)
- Supported roles: `system`, `user`, `assistant`
- Tool messages, multimodal content parts, and `null` content should return an error in v1

## Authentication

Mark this endpoint as `ADMIN_OPTIONAL` — same auth policy as snapshot endpoints. If neither `api_key` nor `admin_api_key` is configured, requests are allowed without auth.

## Files to Modify

### 1. `python/sglang/srt/entrypoints/openai/protocol.py`

Add Pydantic models:

```python
class TokenizeChatMessage(BaseModel):
    role: str
    content: str

class TokenizeChatRequest(BaseModel):
    messages: List[TokenizeChatMessage]
    add_generation_prompt: bool = True

class TokenizeChatResponse(BaseModel):
    success: bool
    token_ids: Optional[List[int]] = None
    token_count: Optional[int] = None
    chat_template_name: Optional[str] = None
    message: Optional[str] = None
```

### 2. `python/sglang/srt/entrypoints/openai/serving_tokenize.py`

Add a new handler class `OpenAIServingTokenizeChat` that:

1. Validates the request (non-empty messages, supported roles/content)
2. Converts messages to the format expected by `apply_chat_template`
3. Calls `self.tokenizer_manager.tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=request.add_generation_prompt)`
4. Returns the token IDs

**CRITICAL**: The chat template application must follow the **exact same code path** as `serving_chat.py` uses for standard chat completion requests. Look at how `serving_chat.py` handles the "standard template path" (not the DSv3.2 special case). The key call is:

```python
prompt_ids = self.tokenizer_manager.tokenizer.apply_chat_template(
    openai_compatible_messages,
    tokenize=True,
    add_generation_prompt=True,
    tools=tools,  # None for v1
    return_dict=False,
    **extra_template_kwargs,
)
```

For v1, `tools` should be `None` and `extra_template_kwargs` should be empty. The messages should be converted to dicts matching what `apply_chat_template` expects.

### 3. `python/sglang/srt/entrypoints/http_server.py`

Register the route:

```python
@app.post("/tokenize_chat")
async def tokenize_chat(request: TokenizeChatRequest, raw_request: Request):
    # Same auth pattern as snapshot endpoints (ADMIN_OPTIONAL)
    # Delegate to OpenAIServingTokenizeChat handler
```

Follow the existing pattern used for snapshot endpoints. The endpoint should:
- Be accessible at the root level (same as `/save_snapshot`, not under `/v1/`)
- Use the same auth middleware/pattern as snapshot routes
- Not go through the scheduler (tokenization is CPU-only, no GPU needed)

### 4. Tests

Add a test file or extend existing tests to cover:
- Basic tokenization: send known messages, verify token IDs match what `/v1/chat/completions` would produce
- `add_generation_prompt: true` vs `false`
- System message handling
- Multi-turn conversations
- Empty messages array → error
- Unsupported role/content → error
- Token ID consistency: same messages → same token_ids every time

## Critical Constraints

1. **Template consistency is non-negotiable.** If `/tokenize_chat` and `/v1/chat/completions` produce different token sequences for the same messages, the compatibility bridge in the provider will silently fall back to stateless mode (safe but wasteful). Worse, if they produce subtly different tokenizations that happen to prefix-match incorrectly, it could cause state desync.

2. **Do not add a dependency on the scheduler or GPU.** Tokenization is CPU-only and should be handled entirely in the HTTP server process via the tokenizer.

3. **The endpoint must work even when snapshot persistence is disabled.** It's a general-purpose utility that happens to be needed by the compatibility bridge.

4. **`chat_template_name` in the response is diagnostic only.** If the template name cannot be determined, return `null` rather than erroring.

## Validation Criteria

The agent's work is complete when:

1. `POST /tokenize_chat` returns correct token IDs for test messages
2. Token IDs match what `serving_chat.py` would produce for the same input
3. Error cases return appropriate errors with `success: false`
4. Auth behavior matches snapshot endpoints
5. Tests pass
