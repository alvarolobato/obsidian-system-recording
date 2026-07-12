# Speaker separation & transcription: options analysis

Research doc, July 2026. Scope: how we currently tell "me" apart from "them" in a
recording/transcript, why it's clunky, how competitors (Granola) and the wider
OSS ecosystem solve it, and what paths are available if we want to modernize —
including going real-time/online instead of post-meeting batch, and/or going
local instead of cloud STT.

This is a research/options doc, not a plan. Nothing here is committed to.

## 1. Where we are today

The plugin (macOS-only for this feature) uses a native Swift helper
(`swift-helper/Sources/SystemRecorder`) that captures **two independent audio
streams** at once:

- **Mic** via `AVAudioEngine` — "me".
- **System/other-participant audio** via `ScreenCaptureKit` — "them" (all other
  participants lumped into one channel; not per-person diarization).

When speaker-separation is enabled, the helper writes `*.me.wav`, `*.them.wav`,
and a `*.speech.json` sidecar (RMS-based rough voice-activity windows per
stream), in addition to the always-written mixed stereo file.

On the Node side, `TranscriptionService.transcribeDiarized()` sends the two
files through OpenAI's cloud transcription API (`gpt-4o-transcribe` or
`whisper-1`) **sequentially, after the meeting ends** — full pass on `me.wav`,
then (usually) a full pass on `them.wav`. `diarize.ts` then dedupes each
stream, drops segments that fall outside the RMS speech windows (filtering
Whisper hallucinations), and interleaves both streams purely by timestamp into
`Me:` / `Them:` lines.

**Why it's clunky, concretely:**

- Two (sometimes three, on a capability-miss fallback) full paid API calls per
  meeting instead of one — cost and latency both scale up.
- Not real diarization — just two pre-known channels merged by timestamp; "them"
  can never be split into individual named speakers.
- VAD has to be force-disabled on both passes because independent per-stream
  silence-trimming would desync the shared timeline — a direct consequence of
  transcribing two files separately instead of one synchronized stream.
- Dictionary correction / hallucination cleanup only runs on the mixed-file
  path, not the diarized segments (documented as a known v1 limitation in the
  code).
- Everything happens **after** the meeting — no live transcript, no ability to
  show notes forming in real time.
- The RMS speech-detection threshold is a fixed value, acknowledged in-code as
  unreliable for quiet speech.

## 2. How Granola does it (for comparison)

Sourced from a Cognitive Revolution podcast interview with Granola co-founder
Sam Stephenson, Granola's own docs, and third-party analyses (exact capture
internals aren't publicly documented, so some of this is inferred).

- Granola streams audio **live, in real time**, to third-party cloud STT
  (Deepgram and AssemblyAI, run in parallel for redundancy — not Whisper).
  Transcript builds as the meeting happens; notes are ready almost immediately
  after the call ends.
- Speaker separation on desktop is **the same coarse split we already do**:
  capture mic and system audio simultaneously and label turns "Me" vs "Them".
  It is *not* true multi-participant diarization on desktop — that only exists
  in their iPhone app, for in-person meetings.
- Stephenson explicitly says the streaming approach is a **quality tradeoff**:
  "The quality is a bit worse. The speaker separation is a lot worse" than if
  they batched all audio and transcribed it in one pass afterward. Real-time
  UX is bought at the cost of accuracy — the opposite tradeoff of what we
  currently make.
- No offline/local mode exists at all; no audio is retained server-side once
  transcribed (cited as core to fast SOC 2 compliance).
- Transcription cost was, in Stephenson's words, "half of our burn rate as a
  company" early on — a signal that streaming STT at meaningful scale is a
  real cost center, not an afterthought.

**Takeaway:** Granola is not solving the "me vs. them" problem more elegantly
than we do — it uses the identical binary mic/system split. The actual
difference is *when* transcription happens (live vs. after-the-fact) and that
it accepts a known quality regression to get there. Copying Granola's
architecture buys us "live notes," not "better speaker attribution."

## 3. Option catalogue

### A. Status quo, cleaned up (incremental)

Keep dual-stream capture + offline batch transcription, but fix the known
sharp edges: transcribe both files in parallel instead of sequentially, apply
post-processing (dictionary correction, hallucination cleanup) to diarized
segments too, and replace the fixed RMS threshold with a proper VAD (e.g.
WebRTC VAD or Silero VAD, both cheap/local).

- **Pros:** Smallest change surface; no new infra; keeps using an API we
  already pay for and trust; fixes the most concretely "clunky" parts (latency
  from serial calls, missing post-processing) without a rewrite.
- **Cons:** Still two paid API calls per meeting; still no live transcript;
  still a binary me/them split with no true multi-person diarization for the
  "them" side.
- **Cost:** Low dev effort (days). Runtime cost unchanged (~2x a single
  transcription call, ~$0.006–0.017/min per stream depending on model).

### B. Real-time / streaming transcription (Granola-style, still cloud)

Stream mic + system audio to a streaming-capable cloud STT (OpenAI's realtime
transcribe API, Deepgram, AssemblyAI, etc.) as the meeting happens, showing a
live-building transcript, with "Me"/"Them" labels driven by which stream a
chunk came from (same binary split as today, just live).

- **Pros:** Live transcript is a genuine, user-visible upgrade (matches
  Granola's headline feature); no more waiting after the meeting ends; removes
  the "did the recording actually work" anxiety of fully offline processing.
- **Cons:** Real quality regression, per Granola's own admission — streaming
  STT is measurably worse than batch, especially at utterance boundaries;
  requires a persistent network connection during the whole meeting (today's
  design tolerates being fully offline until upload time); more complex
  session/connection-management code; still doesn't solve true diarization.
  OpenAI's realtime transcribe pricing (~$0.017/min) is roughly 3x its batch
  Whisper pricing.
- **Cost:** Medium-high dev effort (new streaming client, reconnect/backoff
  logic, incremental note-rendering UI). Runtime cost higher than status quo
  per-minute; still a metered cloud dependency.

### C. Local/offline transcription (privacy + cost, batch or live)

Replace the OpenAI cloud call with a local Whisper engine.

- **whisper.cpp** (MIT, C/C++, no Python) is the best fit for a macOS-focused
  Electron/Node plugin: Metal/Core ML acceleration on Apple Silicon (Core ML
  offloads the encoder to the Neural Engine for a further ~2–3x speedup over
  Metal alone), invoked by spawning the compiled binary from Node (directly,
  or via the `nodejs-whisper` npm wrapper — actively maintained; `whisper-node`
  is stale). Ships a real-time `stream` example (naive 0.5s-chunk polling —
  usable as a starting point, not production-grade on its own).
- **faster-whisper** (CTranslate2/Python) is the other well-known local
  engine, but has no first-class Apple Silicon GPU/ANE path — whisper.cpp is
  generally the faster, more native choice on macOS.
- **The linked repo, `yut0takagi/faster-whisper-file-app`, is not an
  embeddable library** — it's a full-stack demo (Next.js/FastAPI/Docker
  Compose) wrapping faster-whisper with a drag-and-drop UI and LMStudio-based
  local-LLM meeting-minutes summarization. Useful as a *feature/UX reference*
  (the transcription→local-LLM-summary pairing is exactly our
  enrich/dashboard use case) but not something to shell out to piecemeal; you'd
  be running its whole Docker stack alongside Obsidian, which is heavy for a
  plugin.
- **Transformers.js** (Hugging Face, ONNX Runtime + WebGPU) can run Whisper
  fully in-process inside Electron with no native binary at all — simplest
  packaging story, but slower and more quantization-sensitive than
  whisper.cpp+Metal/Core ML.

- **Pros:** Zero marginal per-minute cost; works fully offline; no data leaves
  the machine (privacy story competitive with or better than Granola's "we
  discard audio after transcribing" claim, since audio never leaves at all);
  removes the OpenAI API as a hard dependency/cost center.
- **Cons:** Model download/bundling (100MB–3GB depending on model size) adds
  install footprint; local inference quality on the largest cloud models
  (gpt-4o-transcribe) may still edge out local Whisper on noisy audio/accents;
  need to manage model updates ourselves; shelling out to a native binary from
  an Electron plugin needs the same code-signing/packaging care the existing
  Swift helper already required, so it's incremental complexity, not new
  categories of complexity.
- **Cost:** Medium dev effort (bundle + invoke whisper.cpp, pick a
  model-size/quality default). Runtime cost: effectively $0/min marginal;
  break-even vs. cloud API pricing only matters at very high volume, which is
  irrelevant for a single-user desktop plugin — the real driver here is
  privacy/offline-capability, not raw dollars saved.

**If cloud transcription is effectively free to the user** (e.g. covered by
an employer's existing OpenAI/enterprise agreement), the cost argument above
mostly disappears — that was the weaker justification for local Whisper
anyway at single-user volume. What survives: privacy/offline-capability,
lower latency (no upload round-trip, matters more if we ever go real-time),
and independence from IT/API-access changes (model deprecation, org policy,
rate limits) outside our control. If none of those matter in a given
deployment, local Whisper becomes a "nice to have," not a clear win — worth
being explicit about rather than defaulting to "cheaper is better."

**Meetily vs. building local Whisper into the plugin ourselves:** Meetily
isn't a library to embed — it's a full standalone app (its own Rust backend,
UI, storage, and summarization). Adopting it wholesale would mean giving up
Obsidian-native integration (calendar linking, note templates, dashboard,
retention logic) in favor of a separate app. Its value to us is as an
**architecture reference** — proof that whisper.cpp/Parakeet + diarization +
local-LLM summarization works well together at scale (~20k stars, active) —
not as a dependency we'd pull in. We'd still build our own whisper.cpp
integration inside the plugin; Meetily just de-risks the approach.

### D. Real diarization / voice identification (who specifically is talking)

To go beyond "me vs. everyone else" toward naming individual participants:

- **pyannote.audio** (MIT, Python) — the standard diarization toolkit ("who
  spoke when", not identity). Free for commercial use but gated behind a
  Hugging Face token; running it means embedding a Python runtime inside the
  Electron app — real packaging burden for a TypeScript/Swift codebase.
- **WhisperX** (Python) — chains faster-whisper + forced alignment + pyannote
  for word-level speaker-labeled transcripts. Same Python-embedding cost as
  pyannote, plus an additional model download.
- **SpeechBrain / Resemblyzer / NVIDIA NeMo** — speaker *identification*
  (enroll a voice, later recognize "this is Alice") via embedding + cosine
  similarity. All Python; NeMo is the most accurate/heaviest, Resemblyzer the
  lightest/least robust.
- **FluidAudio** (Swift, CoreML/ANE-native, macOS 14+) — the most promising
  "no Python" option found: on-device diarization + VAD + ASR (Parakeet)
  running natively via CoreML, claimed faster real-time-factor than pyannote.
  Would still need an enrollment/embedding layer on top for *named* speaker
  identification, but avoids the Python-in-Electron problem entirely and could
  plug into our existing Swift helper.
- **Apple's `SFSpeechRecognizer`/newer `SpeechAnalyzer`** have **no built-in
  diarization or speaker-ID** — not an option on its own.
- **Capture-side improvement, orthogonal to all of the above:** macOS 14.4+'s
  Core Audio Process Taps (`CATapDescription`/`AudioHardwareCreateProcessTap`)
  give finer-grained, official system-audio capture than ScreenCaptureKit,
  and could reduce the amount of "them = everyone else mixed together" problem
  if we can tap specific processes — but this only helps distinguish
  "your app" from "the OS," not distinguish individual remote participants
  from each other, since remote audio still arrives pre-mixed from the
  conferencing app.

- **Pros:** Only path to genuinely naming individual remote participants
  (today: "Them" is irreducibly one lumped channel, since the conferencing
  app itself mixes all remote audio before we ever see it — no local capture
  technique can un-mix that after the fact); would make transcripts
  meaningfully more useful for 3+ person meetings.
- **Cons:** Highest complexity option by far. Python-based tools (pyannote,
  WhisperX, SpeechBrain, NeMo) all require embedding a Python runtime, model
  downloads, and HF-token handling inside an Electron/Obsidian plugin — a
  significant new dependency category we don't have today. The Swift-native
  FluidAudio path avoids that but is a much younger, less-proven project.
  None of this solves the "them" channel being pre-mixed by the conferencing
  app — diarization would run *on* the already-mixed "them" stream, which is
  strictly easier than diarizing a fully mixed mic+system recording, but still
  can't do better than the underlying audio allows.
- **Cost:** High dev effort (new runtime dependency, packaging, testing across
  meeting sizes). Local compute cost only (no per-minute fee) but real CPU/GPU
  load during/after meetings.

#### Recommended enrollment UX: confirm-as-you-go, not upfront recording

If we ever pursue named speaker identification, the enrollment step shouldn't
be a dedicated "record your voice" onboarding flow — nobody does those. A
better pattern, closer to how photo apps handle face clustering ("who is
this?"):

1. Run diarization on the "them" stream, producing unnamed speaker clusters
   (Speaker A, B, C...) for that meeting.
2. Pick a clean representative clip per cluster and ask the user to label it,
   pre-populated with the meeting's calendar-invite attendee list (already
   available via `googleCalendar.ts`) rather than free text — a 3-5 person
   pick-list is a far easier matching problem than open-world identification.
3. Compute a voice embedding from the confirmed clip and store it as that
   person's voiceprint (a small fixed-size vector, not raw audio).
4. On future meetings, match new speaker clusters against stored voiceprints
   by similarity; only fall back to asking when confidence is low.

This turns enrollment into a side effect of normal use instead of a setup
tax, and pays off fastest for recurring meetings (standups, 1:1s) where the
same people repeat — often zero manual input after the first meeting or two.

Caveats worth designing around up front, not blockers:
- **Cross-meeting matching is harder than in-call diarization.** A voiceprint
  captured through one conferencing app's audio compression may not match
  cleanly against another week's call from a different device — expect lower
  confidence than within-meeting diarization, and design the UI around "not
  sure, please confirm" rather than silent auto-labeling.
- **Attendees ≠ speakers.** Invite lists won't always match who actually
  spoke (dial-in guests, shared room accounts, declined-but-joined) — the
  picker needs an "other / not in this list" escape hatch.
- **This layer only names speakers it doesn't fix diarization itself** — if
  the underlying diarization can't cleanly separate two similar voices in the
  pre-mixed "them" stream, naming doesn't help.
- **Voiceprints are biometric data.** Even stored locally as embeddings
  rather than raw audio, this should plug into the plugin's existing
  retention/deletion logic (`retention.ts`) rather than living outside it,
  especially since meetings may include candidates or customers, not just
  colleagues.

## 4. Obsidian community & adjacent open-source landscape

No existing Obsidian plugin solves this well today — worth knowing so we don't
duplicate effort, and worth mining for patterns/code:

**Obsidian plugins:**
- **Whisper** (nikdanilov, MIT, ~366★, active) — mic-only recording + Whisper
  API transcription. No system audio, no diarization.
- **Meeting Notes** — transcribes existing audio files via OpenAI's
  `gpt-4o-transcribe-diarize`, with a chunk-reconciliation step to keep
  speaker labels consistent across chunks. Cloud-only. The
  reconciliation-across-chunks idea is reusable regardless of which STT we use.
- **VoxNote** (formerly "Deepgram Meeting STT") — Deepgram STT with per-speaker
  timestamps + Gemini summary. Cloud-only.
- Several `obsidian-transcription` forks — mostly file-based Whisper
  transcription (some with local Whisper/Ollama variants), no diarization, no
  system-audio capture, fragmented/varying maintenance.

**Adjacent open-source projects (not Obsidian plugins, but directly relevant
prior art):**
- **Meetily** (Zackriya-Solutions, MIT, ~18–22k★, very active) — the strongest
  reference: Rust backend, local Parakeet/Whisper transcription, **diarization
  built in**, local-LLM summarization, macOS+Windows. Worth reading closely
  before building anything from scratch.
- **Scripta** (thehwang, MIT) — dual-channel recorder using ScreenCaptureKit +
  whisper.cpp + SFSpeechRecognizer, 100% local — architecturally the closest
  match to our current mic/system split, useful as a reference for cleaning up
  our own dual-stream handling.
- **Anarlog, Muesli, OpenWhispr** (all MIT) — local-first Granola-style note
  apps; useful as UX/architecture references.
- **pasrom/meeting-transcriber, Parrot, pensieve, Recap, MoonshineNoteTaker,
  ownscribe** — smaller Swift/CLI projects, several separating mic vs. system
  audio before transcription, confirming the dual-stream pattern is the
  current macOS industry norm (not something to abandon, just to clean up).
- **Screenpipe** (~18k★) — good ScreenCaptureKit reference but is
  **source-available/commercial-licensed**, not MIT; do not vendor code from
  it into a distributed plugin without a commercial license.

**License note:** everything flagged MIT above is safe to read/borrow patterns
from or vendor small pieces of; Screenpipe is reference-only; any GPL-licensed
whisper.cpp bindings encountered along the way should be checked individually
since GPL would force copyleft on a bundled/distributed plugin.

## 5. Summary comparison

| Option | Live transcript? | True per-person diarization? | New runtime deps | Per-minute cost | Dev effort |
|---|---|---|---|---|---|
| A. Status quo, cleaned up | No | No | None | ~2x current cloud STT cost | Low |
| B. Real-time streaming (cloud) | Yes | No | Streaming STT client | Higher (~3x batch API) | Medium-high |
| C. Local Whisper (whisper.cpp) | Optional (batch or live) | No | Bundled native binary | ~$0 marginal | Medium |
| D. Local diarization/voice-ID | Optional | Yes (partial — still limited by pre-mixed "them" audio) | Python runtime (or FluidAudio/Swift) | ~$0 marginal, higher compute | High |

## 6. Observations, not a plan

- Granola's architecture is not inherently better at the "me vs. them"
  problem — it's the same binary split we already do, just streamed live and
  explicitly traded for lower diarization accuracy. If we chase "live
  transcript" for its own sake, we should go in with eyes open that it's a
  quality tradeoff, per Granola's own founder.
- The one thing no local-capture trick can fix is that "them" is
  pre-mixed by the conferencing app before it ever reaches us — actual
  per-participant diarization (option D) is the only way to un-lump it, and
  it's also the most expensive option to build.
- Local transcription (option C) looks like the most attractive
  near-to-medium-term move on its own merits (cost, privacy, offline-capable)
  independent of whether we ever pursue real-time or per-person diarization —
  it doesn't foreclose either of those paths later.
- Meetily (MIT, very active, diarization already solved) is worth a closer
  read as prior art before any implementation work starts here, regardless of
  which direction we lean.
