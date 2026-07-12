# Recording format overhaul: mono 24 kHz + optional AAC (fixes #26, #8, #10, #29)

Status: implemented (PR #60). Design agreed with @alvarolobato 2026-07-12.

## Problem

Issue #26: a 1h recording is ~635 MB of WAV, and the vendored transcription
engine decodes the whole file in the Obsidian renderer, so a 2-3h meeting can
OOM the Electron window. Two findings from the code sharpen the picture:

1. **The "stereo" mix carries no stereo information.** `AudioMixer.finalize()`
   sums the mic into *both* channels and the system audio into both channels
   (`AudioMixer.swift:212-242`). Speaker separation lives entirely in the mono
   `me.wav` / `them.wav` sidecars. The second channel of the main mix is a
   byte-for-byte duplicate, so recording mono loses nothing.
2. **Sidecars make the bloat worse than #26 states.** With speaker separation
   on, the helper also writes two device-rate mono Int16 sidecars (~318 MB/h
   each), so a 1h meeting is ~1.27 GB in the vault, not 635 MB.

Two adjacent bugs live in the same function and get fixed by the same rework:

- **#8** — the mic stream is mixed without sample-rate conversion; the
  "Simple case: just read what we can" branch (`AudioMixer.swift:184`) is the
  bug. Desynced, pitch-shifted mic audio on hardware whose mic rate differs
  from the ScreenCaptureKit rate.
- **#10** — `finalize()` reads both full-length streams into RAM to mix them
  (unbounded memory on long meetings), swallows every error into
  `return 0`, and the `guard isSystemWriting` discards mic-only recordings.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Codec | AAC-LC in `.m4a` | The only natively encodable lossy format on macOS (`AVAudioFile` + `kAudioFormatMPEG4AAC`, no new dependencies). MP3 encode would mean vendoring LAME. Obsidian plays `.m4a` inline, the vendored engine lists it in `SUPPORTED_FORMATS`, OpenAI-compatible STT accepts it. |
| Channels | Mono everywhere | The stereo mix was already a mono duplicate (finding 1). |
| Sample rate | 24 kHz | Whisper resamples to 16 kHz internally, but two things benefit from 24: the GPT-4o transcribe path (already wired in the vendored engine) and the planned Realtime/live transcription (#33) run natively on 24 kHz audio, and vault playback for humans — 16 kHz sounds like a phone call, 24 kHz keeps sibilance. At a fixed AAC bitrate the size cost of 24 vs 16 is ~zero, and renderer decode memory is set by the 16 kHz `AudioContext`, not the file rate. Single constant if we change our minds. |
| Bitrate | 64 kbps mono | Transparent-enough for speech; ~28 MB/h. |
| Toggle | Plugin setting "Compressed recordings (m4a)", default **on** | When off: WAV, still mono 24 kHz Int16 (~173 MB/h). The toggle controls compression only, not the mono/24 kHz decisions. |
| Sidecars | Same format as the main recording | They are full-length streams stored in the vault; leaving them WAV would dominate the savings. |

### Size and memory, 1h meeting with speaker separation

| | Today | WAV toggle-off | m4a (default) |
|---|---|---|---|
| Main recording | 635 MB | 173 MB | ~28 MB |
| Sidecars (2×) | ~636 MB | ~346 MB | ~56 MB |
| Vault total | ~1.27 GB | ~519 MB | ~84 MB |
| Renderer peak during decode (2h meeting) | 1.3-2.8 GB transient | ~0.5 GB | ~0.5-0.7 GB |
| Helper peak at stop | full recording in RAM | flat (chunked) | flat (chunked) |

## Design

### Swift helper (`swift-helper/`, the bulk of the change)

Restructure the mixer from "buffer everything, whole-file RAM mix at stop" to
streaming, in three moves:

1. **Capture at target rate where the OS allows it.** Set
   `SCStreamConfiguration.sampleRate = 24000` and `channelCount = 1` so the
   system stream arrives pre-converted. The mic tap stays at device format
   (AVAudioEngine input requirement) and is converted per-buffer with
   `AVAudioConverter` to 24 kHz mono **at append time** — this is the real fix
   for #8, applied where the rates are still known instead of at the end.
   Temp files become 24 kHz mono Int16 PCM (~86 MB/h each).
2. **Chunked finalize.** At stop, read the two temps in 8k-frame chunks
   (the sidecar writer at `AudioMixer.swift:292` already works this way), sum
   with clamping, and write chunks straight out. Memory stays flat for any
   meeting length. While in there, fix the rest of #10: propagate errors to
   the `stopped`/`error` JSON instead of `return 0`, and mix from whichever
   streams exist so mic-only recordings survive.
3. **Encode at stop, not live.** The output writer is an `AVAudioFile` created
   with AAC settings (m4a) or Int16 settings (wav) behind one interface; the
   chunked mix feeds it either way. Encoding a 2h meeting is a few seconds of
   non-realtime work at stop. This also answers the crash-safety concern with
   m4a: a half-written m4a (no moov atom) is unreadable, but here the on-disk
   state during the meeting is plain PCM — a crash mid-meeting leaves
   salvageable temps. (A recovery command is #7's scope, deliberately not
   absorbed here.)

CLI: `system-recorder start --output <path> --stop-file <path> [--split]
[--format m4a|wav]`, defaulting to `wav` so an old plugin driving a new binary
keeps current behavior. The plugin passes the setting. Shipping a new helper is
routine: provisioning downloads the binary from this repo's own releases and
verifies the per-release SHA (`src/binary.ts`).

Sidecars are produced by the same chunked pass and the same writer abstraction,
named `<stem>.me.m4a` / `<stem>.them.m4a` (or `.wav`), mirroring
`sidecarPathsFor` in `src/transcribe/sidecar.ts` as today.

### Plugin (`src/`)

- New setting + i18n string; pass `--format` in `Recorder.start`.
- Generalize the `.wav` assumptions: `uniqueWavPath` in `main.ts` takes the
  extension from the setting; `sidecar.ts` regexes accept `wav|m4a`
  (`sidecarPathsFor`, `isSidecarPath`, `baseRecordingPathOf`); audit remaining
  `\.wav` matches in `main.ts` / `probe.ts`. Retention already accepts m4a
  (`recordings/retention.ts` `isAudioExt`).
- **#29 (absorbed):** auto-transcribe currently no-ops when the finished
  recording isn't in Obsidian's vault index yet. We touch this exact handoff
  for the extension change, so fix the race here: resolve the `TFile` via a
  `vault.on("create")` subscription with a timeout fallback instead of a
  single immediate lookup.
- Old `.wav` recordings keep working untouched: transcription resolves by
  `TFile`, and sidecar discovery accepts both extensions.

### Vendored engine (`src/transcribe/vendor/`, two tiny marked patches)

Scope deliberately minimal per the keep-pristine boundary and #28. From #26's
option 2, only the highest-value pair, both `MEETING-COPILOT PATCH`-marked and
added to the VENDOR.md table:

- `WebAudioEngine.convertToTargetFormat` stops pinning the decoded
  `AudioBuffer` in `ProcessedAudio.source` (`WebAudioEngine.ts:165`), so the
  ~0.5 GB decode result is collectable during chunk processing.
- Release the decoded buffer / encoded copy references as soon as conversion
  finishes in the decode path.

Not doing: the lazy chunk-WAV rewrite from #26. It's the largest vendor diff
and the least needed once the input is mono 24 kHz.

## Scope

Fixes: **#26** (both sides), **#8**, **#10**, **#29**.

Explicitly out: **#7** (full crash-recovery command; this work leaves
salvageable PCM temps as a side effect), **#12** (provisioning strategy),
**#28** (vendor prune), **#9** (device-change stream death, capture-manager
scope), lazy vendor chunking.

## Implementation plan

Two PRs so the helper and the plugin land reviewably:

1. **Helper rewrite** — streaming conversion, chunked finalize, error
   propagation, mic-only support, `--format`, sidecar writers. Default
   `wav` keeps the current plugin compatible. Swift-side change only.
2. **Plugin format plumbing** — setting + i18n, `--format` pass-through,
   extension generalization (`uniqueWavPath`, `sidecar.ts`, audit), #29 race
   fix, the two vendor patches + VENDOR.md rows, tests (`sidecar.test.ts`,
   retention, settings migration default).

Verification: unit tests for the extension/sidecar plumbing; manual end-to-end
on macOS — record a short meeting in both formats, confirm Obsidian inline
playback of the m4a, confirm transcription (including the diarized me/them
path) on both, confirm a 16 kHz `AudioContext.decodeAudioData` of a helper-made
m4a in the Obsidian devtools before trusting the pipeline (Electron ships the
AAC decoder, but this is the load-bearing assumption worth 2 minutes of
checking).

## Risks

- **Electron AAC decode**: verified assumption above; if a build ever drops
  the codec, the WAV toggle is the escape hatch.
- **Helper/plugin version skew**: new plugin + old binary would error on the
  unknown `--format` flag, but provisioning pins the binary per release, so
  the pair always ships together; the default keeps the reverse direction
  (old plugin, new binary) working.
- **STT endpoint quirks**: some self-hosted OpenAI-compatible gateways are
  picky about container formats. Chunk uploads are unaffected (the vendored
  chunker re-encodes WAV chunks from PCM), so exposure is limited to
  whole-file paths; the toggle covers the rest.
