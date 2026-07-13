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
| `infrastructure/api/dictionary/GPTDictionaryCorrectionService.ts` | base URL + optional chat model id from `endpointConfig` | GPT-assisted dictionary correction on a renaming gateway (default `gpt-4o-mini` won't exist there) |
| `infrastructure/storage/SecurityUtils.ts` | `validateOpenAIAPIKey` accepts any non-empty key | non-`sk-` gateway keys |
| `application/TranscriptionController.ts` | `transcribe()` also returns `segments` on its object form when the model produced timestamps (was dropped), carrying optional per-segment `noSpeechProb`/`avgLogprob`/`compressionRatio` | me-vs-them speaker separation merges two mono streams on a shared timeline and needs per-segment times (issue #32); confidence signals drop silence hallucinations (issue #54) |
| `infrastructure/api/openai/WhisperClient.ts` | `parseResponse` forwards `no_speech_prob`/`avg_logprob`/`compression_ratio` from `verbose_json` onto the mapped segments | silence-hallucination filtering in the diarized merge (issue #54) |
| `core/transcription/TranscriptionTypes.ts`, `core/transcription/TranscriptionStrategy.ts`, `application/workflows/TranscriptionWorkflow.ts` | segment types widened with the three optional confidence fields | thread the Whisper confidence signals from the client up to the caller (issue #54) |
| `core/audio/AudioTypes.ts` | `ProcessedAudio.source` made optional | never read; pinning the decoded AudioBuffer OOMs long meetings (issue #26) |
| `infrastructure/audio/WebAudioEngine.ts` | stop populating `ProcessedAudio.source` | drops a decoded-AudioBuffer pin worth ~460 MB on a 2h meeting (issue #26) |
| `infrastructure/audio/FallbackEngine.ts` | stop populating `ProcessedAudio.source` | same pin as WebAudioEngine (issue #26) |
| `infrastructure/api/ApiClient.ts` | `executeWithRetry` now retries transient network-level throws (`net::ERR_NETWORK_IO_SUSPENDED`, `ECONNRESET`, timeouts, …) with the existing exponential backoff | upstream re-threw them immediately, so a brief network drop mid-transcription failed a chunk permanently and sheared the transcript |
| `application/TranscriptionController.ts` | one `warn` → `debug` for "local VAD unavailable" | server-side chunking is our expected mixed-path default, so it fired on every run |
| `config/ModelProcessingConfig.ts` | `whisper`/`whisperTs`: `maxConcurrentChunks` 2 → 6, `rateLimitDelayMs` 3000 → 1000 | our LiteLLM/whisper gateway runs ~2.5x real-time per chunk, so 2-wide made a 30-min meeting take ~1700s/pass (x2 diarized); the gateway tolerates more parallelism and the network-retry backoff absorbs 429s |

Two files are **added** (not from upstream):

- `ui/ProgressTracker.ts` — a small headless implementation of the controller's
  optional `progressTracker` dependency (upstream drove it from a modal UI).
  Keeps one always-live task so the controller's progress adapter fires, and
  forwards the engine's unified percentage to a callback (the status bar).
- (outside this dir) `../endpointConfig.ts` — the base-URL seam the patches read.

## Runtime notes

- **Key storage:** Meeting Copilot passes the key prefixed with `PLAIN::` so the
  vendored `SafeStorageService.decryptFromStore` returns it verbatim (no edit).
- **VAD:** the vendored engine still runs the mixed path with `server` /
  `disabled` (fixed-window chunking). Meeting Copilot additionally reuses the
  vendored `vad/processors/WebrtcVadProcessor.ts` **outside** the engine —
  `../vadWindows.ts` runs it over the me/them sidecars to compute speech windows
  for the diarized merge. `@echogarden/fvad-wasm` is therefore now a real
  bundled dependency (the glue compiles into `main.js`) and `fvad.wasm` ships as
  a plugin asset (copied next to `main.js` by esbuild / deploy-local / release).
  If the WASM is absent, window detection falls back to the recorder's RMS
  `speech.json`, then to no filtering.
- **i18n:** `../TranscriptionService.ts` calls the vendored
  `initializeTranslations()` / `initializeI18n()` once at load.

## Re-syncing from upstream

1. Copy upstream's closure files over this tree (keep the file list stable).
2. Re-apply the `MEETING-COPILOT PATCH` diffs above (they are tiny).
3. `npm run build && npm test`.
