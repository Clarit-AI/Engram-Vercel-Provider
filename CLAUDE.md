# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

`@clarit.ai/vercel-ai-provider` — a Vercel AI SDK provider for [Engram](https://github.com/clarit-ai/engram) (Clarit), adding persistent Mamba state as a drop-in. It wraps `@ai-sdk/openai-compatible` and intercepts generation calls to add auto-save snapshots and restore-and-generate capabilities.

## Publishing

Bump `version` in `package.json`, push to `main`, then create a GitHub Release — the `publish.yml` workflow builds, tests, and publishes to npm automatically. Requires `NPM_TOKEN` secret in repo settings.

## Commands

```bash
npm run build        # tsup — builds ESM + .d.ts to dist/
npm test             # vitest run
npm run test:watch   # vitest --watch
npm run typecheck    # tsc --noEmit
npm run clean        # rm -rf dist
```

Run a single test file:
```bash
npx vitest run test/snapshot-client.test.ts
```

## Architecture

### Two-entry build

`tsup.config.ts` builds two entry points:
- `src/index.ts` → main provider (`@clarit.ai/vercel-ai-provider`)
- `src/snapshots/index.ts` → snapshot subpath (`@clarit.ai/vercel-ai-provider/snapshots`)

Both output ESM only to `dist/`.

### Core flow

```
createClarit()              Factory — creates base OpenAI-compatible provider + snapshot client
  └─ ClaritChatModel        Decorator wrapping the base LanguageModelV1
       ├─ doGenerate()      Standard path delegates to base; restore path calls /restore_snapshot
       └─ doStream()        Standard path pipes through base stream; restore path wraps as single-chunk stream
```

**Key files:**

| File | Role |
|------|------|
| `src/clarit-provider.ts` | Factory. Creates `createOpenAICompatible` base + `ClaritSnapshotClient`. Exports `createClarit` and default `clarit` instance. |
| `src/clarit-chat-model.ts` | The decorator. Intercepts `doGenerate`/`doStream` to inject auto-save and restore-and-generate logic. All Engram-specific behavior lives here. |
| `src/snapshots/snapshot-client.ts` | Standalone HTTP client for Engram snapshot endpoints (`/save_snapshot`, `/list_snapshots`, `/restore_snapshot`, `/get_snapshot_info`, `/delete_snapshot`). Independent of the AI SDK — can be used directly. |
| `src/clarit-provider-options.ts` | Types for `providerOptions.clarit` and response metadata. |
| `src/snapshots/types.ts` | Request/response types mirroring the Engram HTTP API spec. |
| `src/errors.ts` | `ClaritSnapshotError` (app-layer failures) and `ClaritValidationError` (missing required options). |

### Two generation paths

1. **Standard** — delegates to the OpenAI-compatible base model (`/v1/chat/completions`). Optionally fires `autoSaveSnapshot` after completion.
2. **Restore-and-generate** — when `restoreBeforeGenerate: true`, calls `/restore_snapshot` with `create_new_request=true` instead of chat/completions entirely. Requires `conversationId`, `continuationIds`, and `maxNewTokens`.

### Testing

Tests use Vitest with mocked `fetch` (for snapshot client) and mocked base `LanguageModelV1` (for chat model decorator). No live server required. Tests import directly from `src/` (not `dist/`).

## Key Patterns

- **Decorator pattern**: `ClaritChatModel` wraps any `LanguageModelV1` and delegates identity (`provider`, `modelId`) from the base model.
- **Best-effort auto-save**: Save failures are caught and reported in `providerMetadata.clarit.snapshotSaveError`, not thrown.
- **Engram API quirks**: `/save_snapshot` can return `success: false` with HTTP 200; `/restore_snapshot` returns failures as HTTP 500. The snapshot client normalizes both into `ClaritSnapshotError`.
- **Environment variables**: `CLARIT_BASE_URL`, `CLARIT_API_KEY`, `CLARIT_ADMIN_API_KEY`. Admin key takes precedence for snapshot routes.

## Dependencies

- `ai` >=4.0.0 — peer dependency (user installs this)
- `@ai-sdk/openai-compatible` — base provider for standard chat/completions
- `@ai-sdk/provider` + `@ai-sdk/provider-utils` — AI SDK interfaces
