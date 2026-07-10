# Vendored transcription engine

This directory is the transcription engine from
[AI Transcriber](https://github.com/mssoftjp/obsidian-ai-transcriber) (MIT,
© 2025 Musashino Software), driven **headlessly** by Meeting Copilot. There is
no standalone UI — the plugin calls `TranscriptionController.transcribe()`
directly through `../TranscriptionService.ts`.

## What was vendored

The transitive import closure of `application/TranscriptionController.ts`
(chunking, VAD, Whisper/GPT-4o clients, cleaners, transcript merge, dictionary
correction, i18n, config, utils). UI (modal, views, settings tab, ribbon,
`main-api.ts`) and modal-only post-processing were **not** vendored.

## Keep-pristine boundary

Everything here is meant to track upstream **unmodified** so it can be
re-synced, **except** the small, clearly marked patches below. Grep for
`MEETING-COPILOT PATCH` to find them all.

| File | Change | Why |
|------|--------|-----|
| `infrastructure/api/openai/WhisperClient.ts` | base URL + optional wire model id from `../../../../endpointConfig` instead of `WHISPER_CONFIG` | point STT at any OpenAI-compatible endpoint (LiteLLM, …) and send custom deployment names |
| `infrastructure/api/openai/GPT4oClient.ts` | base URL + optional wire model id from `endpointConfig` | same |
| `infrastructure/api/dictionary/GPTDictionaryCorrectionService.ts` | base URL from `endpointConfig` | same, for contextual dictionary correction |
| `infrastructure/storage/SecurityUtils.ts` | `validateOpenAIAPIKey` accepts any non-empty key | non-`sk-` gateway keys |

Two files are **added** (not from upstream):

- `ui/ProgressTracker.ts` — type-only stub for the controller's optional,
  never-supplied `progressTracker` dependency.
- (outside this dir) `../endpointConfig.ts` — the base-URL seam the patches read.

## Runtime notes

- **Key storage:** Meeting Copilot passes the key prefixed with `PLAIN::` so the
  vendored `SafeStorageService.decryptFromStore` returns it verbatim (no edit).
- **VAD:** Meeting Copilot only offers `server` / `disabled`. Local VAD
  (`vad/processors/WebrtcVadProcessor.ts`) dynamically imports
  `@echogarden/fvad-wasm`, which is marked **external** in esbuild and never
  reached at the server default — so no WASM asset ships.
- **i18n:** `../TranscriptionService.ts` calls the vendored
  `initializeTranslations()` / `initializeI18n()` once at load.

## Re-syncing from upstream

1. Copy upstream's closure files over this tree (keep the file list stable).
2. Re-apply the 4 `MEETING-COPILOT PATCH` diffs above (they are tiny).
3. `npm run build && npm test`.
