# Meeting Copilot

A Granola-style meeting workflow for Obsidian on macOS. Meeting Copilot reads your Google Calendar, creates a note from the meeting invite, records **dual-channel** audio (system audio from Zoom / Google Meet / Teams **plus** your microphone), then transcribes and enriches the note with an AI summary and action items — no extra audio driver and no sidecar app. On macOS 14.4+ system audio is captured with a **Core Audio process tap** (audio-only — no Screen Recording permission, no screen-recording indicator, and your notifications aren't suppressed while recording); older macOS falls back to ScreenCaptureKit. Transcription runs either through an OpenAI-compatible endpoint or **fully on-device** with a local Whisper model (no audio leaves your Mac).

## Requirements

- macOS 13.3+ (Apple Silicon)
- Obsidian Desktop
- A Google account (for calendar integration)
- An OpenAI-compatible endpoint (configured as a single base URL in settings), needed for **AI enrichment** and for **remote** transcription. It's **not** required if you transcribe locally and leave enrichment off. OpenAI and LiteLLM work for both transcription and enrichment. **Ollama** has no `/audio/transcriptions` endpoint, so it works for enrichment only. **Azure** requires the `/openai/v1` OpenAI-compatible surface — the classic deployment-path format won't work.
  - Prefer to keep audio local? Set **Transcription → Transcription engine** to **Local (on-device Whisper)** and no endpoint is needed for transcription. See [Local (on-device) transcription](#local-on-device-transcription).

## Features

- **Dual-channel recording** — system audio (via a Core Audio process tap on macOS 14.4+, ScreenCaptureKit on older releases) **plus** microphone, mixed into one file (no extra driver, no sidecar).
- **Google Calendar integration** — upcoming events, attendees, and Meet/Zoom link extraction, built in (no separate calendar plugin required).
- **Meeting agenda sidebar** — a "coming up / recent" list with per-row actions: create note + record, open note, transcribe, enrich, open recording, join link.
- **Automatic notes** — creates a meeting note from the invite, colocates the recording with it, and files recurring meetings into a per-series folder.
- **Transcript → note automation** — when a recording stops it can transcribe automatically and drop a collapsible transcript at the bottom of the note.
- **Local on-device transcription** — optionally transcribe with a local Whisper model (downloaded once) that runs on Apple-Silicon GPUs (Metal); audio never leaves your Mac and there's no per-minute API cost. Falls back to your remote endpoint on failure if you enable it.
- **Granola-style AI enrichment** — generates a summary, key points, decisions, and action items into a gray, collapsible AI-notes callout you can toggle on/off; your manual notes stay untouched.
- **Action items → tasks** — enrichment lifts action items into `## Action items` checkboxes the [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) plugin can track.
- **Recording retention** — recordings older than a configurable number of days are moved to the trash automatically; the transcript stays in the note.
- **Meetings dashboard** — one command builds a [Dataview](https://github.com/blacksmithgu/obsidian-dataview) dashboard of upcoming/past meetings and open action items.
- **Status feedback** — ribbon button / command palette control, plus elapsed-time and action (recording / transcribing / enriching) indicators in the status bar.

## Required & optional plugins

Meeting Copilot handles calendar, recording, transcription, and enrichment on its own — no other plugin is required. Two optional plugins enhance specific features:

| Plugin | Needed for | Required? |
| --- | --- | --- |
| [Dataview](https://github.com/blacksmithgu/obsidian-dataview) | The Meetings dashboard command | Optional |
| [Tasks](https://github.com/obsidian-tasks-group/obsidian-tasks) | Tracking the `## Action items` checkboxes | Optional (checkboxes work without it) |

> **Remote** transcription and AI enrichment share one OpenAI-compatible endpoint configured in Meeting Copilot's own settings: remote transcription needs `/audio/transcriptions` and enrichment needs `/chat/completions`. OpenAI and a LiteLLM proxy serve both. Ollama works for enrichment only (no `/audio/transcriptions`). Azure works only via the newer OpenAI-compatible surface (`/openai/v1`), not the classic deployment-path format. If you switch to the **local** transcription engine, no endpoint is needed for transcription (only for enrichment, when enabled). The remote transcription engine is bundled (vendored from [AI Transcriber](https://github.com/mssoftjp/obsidian-ai-transcriber), MIT); AI Transcriber does **not** need to be installed.

## Installation

**Option A — BRAT (recommended for updates):** install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin, then *Add beta plugin* with `alvarolobato/obsidian-meeting-copilot`. BRAT installs from the latest [GitHub release](https://github.com/alvarolobato/obsidian-meeting-copilot/releases) and keeps it up to date.

**Option B — manual:**

1. From the [latest release](https://github.com/alvarolobato/obsidian-meeting-copilot/releases/latest), download `main.js`, `manifest.json`, `styles.css` (and optionally the `system-recorder` helper — if you grab it, also grab the `whisper` runtime asset, since the helper won't launch without it; see step 2 for exactly where the `whisper` asset goes).
2. Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/meeting-copilot/` in your vault. If you also downloaded the helper, put `system-recorder` in that same folder and place the `whisper` asset at `whisper.framework/Versions/Current/whisper` **inside** it (create those directories) — the plugin only loads the dylib from that exact path, so a `whisper` file dropped next to `main.js` is ignored and it will just re-download the asset on first use. Easiest is to skip the manual helper copy and let step 5 fetch both.
3. In Obsidian, enable **Meeting Copilot** under *Settings → Community plugins*.

Then, regardless of method:

4. Optionally install the plugins from the table above (Dataview, Tasks).
5. On your first recording, the macOS helper (`system-recorder`) and its `whisper` runtime component are downloaded from the matching release and verified (SHA-256) if you didn't already copy them in. macOS then prompts for the capture permissions — grant them, then fully quit and reopen Obsidian. On **macOS 14.4+** you'll be asked for **Microphone** (your mic) and **System Audio Recording** (the process tap; under System Settings → Privacy & Security → **Screen & System Audio Recording**) — but *not* Screen Recording. On **older macOS (including 14.2–14.3, which don't have the System Audio Recording grant)** you're asked for **Screen Recording** and **Microphone** instead (the ScreenCaptureKit fallback). Both grants are attributed to Obsidian. (Apple Silicon / arm64 only.)

   If the process tap can't be created (older OS, or the System Audio Recording grant is denied), the plugin falls back to ScreenCaptureKit automatically. Because that fallback can also happen *mid-recording* (e.g. if Core Audio restarts), the first such fallback may raise a **Screen Recording** permission prompt in the middle of a meeting — and a fresh 14.4+ install that only ever granted System Audio Recording won't have it. If you want the fallback to be seamless, grant Screen Recording too.

### Updating

- **BRAT (Option A)** auto-updates: it watches this repo's [releases](https://github.com/alvarolobato/obsidian-meeting-copilot/releases) and pulls new versions (enable *Auto-update plugins at startup* in BRAT's settings, or run *BRAT: Check for updates*). After an update, the plugin re-downloads the matching `system-recorder` helper on the next recording.
- **Manual (Option B)** installs do **not** auto-update — download the new release assets and replace the files in `.obsidian/plugins/meeting-copilot/` when a new version ships. Your settings (`data.json`) are preserved.
- Obsidian's built-in *Check for updates* only covers plugins in the official community store, so it will **not** update this plugin. Use BRAT.

## Setup

### Google Calendar

1. In the [Google Cloud Console](https://console.cloud.google.com/), create an OAuth 2.0 **Desktop** client and enable the Google Calendar API.
2. In *Settings → Meeting Copilot → Google Calendar integration*, paste the **Client ID** and **Client secret**, then click **Authenticate** and complete the browser sign-in.
3. Optionally set the **Target calendar ID** (defaults to `primary`) and the agenda look-ahead / look-back windows.

Your **client secret** and the OAuth **tokens** are stored in per-vault local storage on this device — not in the synced/committed `data.json` — so re-authenticate once per device. Meetings you've **declined** are ignored (no auto-open, no record prompt). If the connection expires, the agenda shows a **Reconnect** action instead of looping errors.

### AI endpoint (shared)

In *Settings → Meeting Copilot → AI endpoint (shared)*, set the **API base URL** and **API key** for your OpenAI-compatible endpoint. These are used for **AI enrichment** and for **remote** transcription. If you use the local transcription engine and don't enrich, you can leave them blank.

### Transcription

In *Settings → Meeting Copilot → Transcription*, choose a **Transcription engine**:

- **Remote (API endpoint)** *(default)* — pick a **Transcription model** (`gpt-4o-transcribe` is most accurate; `whisper-1-ts` adds word timestamps) served by your shared endpoint, a language, and optionally enable **AI post-processing** and a **custom dictionary** (one `misheard => correct` rule per line).
- **Local (on-device Whisper)** — pick a **Local model** (see the table below); it downloads once and is verified by SHA-256. See [Local (on-device) transcription](#local-on-device-transcription).

Either way, transcription runs headlessly — no dialog — when you transcribe a recording or when *Auto-transcribe when recording stops* is on.

### AI enrichment

In *Settings → Meeting Copilot → AI enrichment*, enable enrichment, then click **Test connection** (under the model row) to load the available chat models from the shared endpoint and pick one from the dropdown.

### Local (on-device) transcription

Set **Transcription → Transcription engine** to **Local (on-device Whisper)** to transcribe entirely on your Mac with a local [whisper.cpp](https://github.com/ggerganov/whisper.cpp) model running on the Apple-Silicon GPU (Metal). Audio never leaves the device and there's no per-minute API cost — enrichment still uses your shared endpoint when enabled.

On your first local transcription the selected **Local model** downloads into the plugin's `models/` folder (unless already present) and is verified by a pinned SHA-256; after that, transcription is fully offline. The `system-recorder` helper and its `whisper` runtime component download the first time the helper runs at all — often your first *recording*, not your first local transcription — and are verified the same way. Only **multilingual** models are offered, so the **Language** setting (`auto` to detect) works as expected.

| Local model | Download | Peak RAM (approx.) | Notes |
| --- | --- | --- | --- |
| `small-q5_1` | ~190 MB | ~0.6 GB | Fastest / smallest; best for older or RAM-constrained Macs. |
| `medium-q5_0` | ~539 MB | ~1.6 GB | Middle ground. |
| `large-v3-turbo-q5_0` *(default)* | ~574 MB | ~1.6 GB | Near large-v3 accuracy at a fraction of the compute; recommended on Max-tier chips. |

The RAM column is a conservative planning estimate; actual peak resident memory is often lower (see Performance below).

Other options in this mode:

- **Separate my voice from others** — because recording is dual-channel (you vs. everyone else), enabling it labels the two sides. It transcribes each channel in its own pass, so it roughly doubles the transcription time versus the mixed track.
- **Fall back to remote on failure** — if a local run fails and a remote endpoint is configured, retry the audio there (non-diarized). Off by default; when it triggers you'll see a "falling back to the remote service" notice.

Switching the transcription engine or the local model is locked while a model is downloading so an in-flight fetch can't be stranded. Switching to a different model keeps the previous one on disk — use the **Delete** button on the **Model file** row to reclaim the ~0.2–0.6 GB when you no longer need it.

**Performance.** On-device transcription runs on the GPU and is typically **much faster than real time**. On one Apple M5 Max (64 GB), the default `large-v3-turbo-q5_0` model transcribed a single track at **~56× real time** (363 s of audio in 6.4 s) at **~0.8 GB peak resident memory** — comfortably under the table's conservative ~1.6 GB estimate. The model loads once and is reused across jobs, so a two-pass **speaker-separated** run is ~2× that wall time. Rules of thumb from these numbers: a 1-hour meeting is **~1 minute** transcribed as a single mixed track, or **~2 minutes** with speaker separation on. Slower / lower-RAM Macs will be proportionally slower — pick `small-q5_1` or `medium-q5_0` there. These are one machine's figures; wall-clock varies by chip, model, and meeting length.

## Usage

- Click the microphone icon in the left ribbon to start/stop an ad-hoc recording.
- Open the **meeting agenda** sidebar to create a note + record, transcribe, enrich, or join a meeting for any calendar event.
- When a calendar meeting starts (or ends while recording), you get a meeting prompt. It **always** appears as an **in-app notice**, so it's waiting for you in Obsidian even if you were away when it fired. When Obsidian is **minimized / behind another app / on another Space**, you *also* get a **native macOS notification** with a primary action button (*Join & record* / *Record* / *Stop recording*) so you're alerted wherever your attention is (when Obsidian is already in front, the native one is skipped — it would just duplicate the in-app notice). Clicking the notification body brings Obsidian forward to the in-app prompt with the full set of choices (*Join*, *Open note*, …).
- Right-click a meeting note (or use the editor menu) to run the same actions — transcribe, enrich, open recording, join link.

### Getting the best notifications on macOS

When Obsidian isn't in front, the plugin posts a native notification, but **macOS** controls whether it pops up on screen or lands silently in Notification Center — an app can't override this. (Either way the in-app prompt is still waiting for you inside Obsidian.) If prompts only show up in Notification Center, check these (there's a shortcut button in the plugin's **Notifications** settings that opens the right pane):

- **Focus / Do Not Disturb** suppresses banners and routes notifications straight to Notification Center. Because a Focus can be scheduled or auto-activate (e.g. during calendar events), this often looks "random". Turn it off, or allow Obsidian through your Focus filter, to see prompts live.
- **Make them stay on screen with a button.** Set Obsidian to the **Alerts** style (**System Settings → Notifications → Obsidian → "Alerts"**). In the default **Banners** style macOS auto-dismisses notifications after a few seconds and collapses actions under an **"Options"** affordance. Note: macOS/Electron can only show **one** notification action as a named button (the primary — e.g. *Join & record*); the remaining choices open when you click the notification body.
- **While recording or mirroring a display**, macOS hides banners unless you turn on **System Settings → Notifications → "Allow notifications when mirroring or sharing the display"** (off by default).

### Debugging notifications

If prompts still misbehave and you want to file a bug report, you can turn on
notification tracing. It's **off by default**, so normally nothing extra is
logged and no extra command exists.

1. Open the DevTools console (**Cmd+Opt+I** → **Console**) and run:

```js
localStorage.setItem("mc:notif-debug", "1")
```

2. Reload the plugin (toggle **Meeting Copilot** off/on, or restart Obsidian).

You'll now get:

- `[mc:notif] …` traces of the whole notification pipeline (window focus,
  which channel was used, and every native/web notification event). They're
  logged at the normal console level so tools that export the console capture
  them — paste these into a bug report.
- A **"Debug test meeting notification"** command in the palette that fires a
  sample prompt after 4 s (click away first to test the not-focused path).

The flag is read when the plugin loads, so it only takes full effect after a
reload — and the debug command likewise only appears while the flag was set at
load time. To turn everything back off:

```js
localStorage.removeItem("mc:notif-debug")
```

then reload the plugin again (this also removes the debug command from the
palette).

## Settings

- **Google Calendar integration**: Client ID / secret, authentication, target calendar, agenda look-ahead / look-back, exclusion keywords.
- **Recording folder** / **File name template**: for ad-hoc recordings.
- **One-off meetings folder** / **New series folder**: `{{year}}`/`{{month}}`/`{{series}}`/`{{title}}`/`{{date}}` templates for where calendar meeting notes (and their recordings) are created. A recurring meeting's later occurrences follow wherever its folder ends up, even if you move it.
- **Handle 1:1s separately** / **One-on-one folder**: file 1:1s (exactly one other attendee) into their own per-person folder instead of the rules above.
- **Ad-hoc meetings folder**: where unplanned (ad-hoc or detected) meeting notes land.
- **Recording retention (days)**: recordings older than this are trashed on startup and via *Clean up old recordings*; `0` keeps them forever. A recording is pruned only when the plugin has durably saved the transcript into its owning meeting note — so notes without the transcript captured (e.g. enriched with *Insert transcript* off), orphan/ad-hoc recordings, and unrelated audio are never deleted.
- **AI endpoint (shared)**: OpenAI-compatible base URL + API key used for AI enrichment and for remote transcription (not needed for the local engine).
- **Transcription**: **Transcription engine** (*Remote (API endpoint)* or *Local (on-device Whisper)*), a transcription model (remote) or **Local model** (local), language, and **Separate my voice from others**. Remote-only: AI post-processing and custom dictionary. Local-only: **Fall back to remote on failure**. Plus **Auto-transcribe when recording stops** (headless — no dialog).
- **AI enrichment**: enable it, pick a chat model (via **Test connection** + dropdown); optionally enrich automatically after transcription.
- **Action items as tasks**: lift enriched action items into `## Action items` checkboxes (preserving existing/completed tasks).

Commands of note: *Clean up old recordings*, *Create/update meetings dashboard*, *Enrich meeting note (AI)*, *Toggle AI notes visibility*.

## Development

```bash
npm install
cd swift-helper && swift build -c release && cd ..
cp swift-helper/.build/release/SystemRecorder system-recorder
npm run dev      # watch build
npm run build    # production build
npm test && npm run lint
```

### The macOS helper (`system-recorder`)

Obsidian's community store distributes only `main.js` / `manifest.json` / `styles.css`, not native binaries. The plugin downloads the `system-recorder` helper on first use from the GitHub release whose tag matches `manifest.json`'s `version`, and verifies it against `EXPECTED_SHA256` in [`src/binary.ts`](src/binary.ts). If you publish your own release, point `REPO` / `EXPECTED_SHA256` in `src/binary.ts` at it, or simply ship a prebuilt `system-recorder` next to `main.js`.

The helper links whisper.cpp's **dynamic** framework, so the `whisper` dylib is a second provisioned asset (pinned by `EXPECTED_WHISPER_SHA256` / `WHISPER_DYLIB_SIZE` in `src/binary.ts`). It's downloaded alongside the helper — even for remote-only users — because the helper won't launch without it, and placed at `whisper.framework/Versions/Current/whisper` next to `main.js`. Local Whisper **models** are separate, on-demand downloads pinned in [`src/transcribe/localModels.ts`](src/transcribe/localModels.ts). For local end-to-end testing, `npm run deploy:local -- --swift` builds the helper + dylib and stages that exact layout into your dev vault.

### Releasing

Releases are automated by [`.github/workflows/release.yml`](.github/workflows/release.yml). To cut a release, push a version tag (no `v` prefix, matching the target `manifest.json` version):

```bash
git tag 1.0.5 && git push origin 1.0.5
```

On an Apple-Silicon runner the workflow lints/tests, syncs `manifest.json` / `versions.json` to the tag, builds the Swift helper (and its `whisper` dylib), verifies both against the SHA-256 (and, for the dylib, the byte size) pinned in `src/binary.ts`, pins the helper's SHA into the build, builds the plugin, and publishes a GitHub release with `main.js`, `manifest.json`, `styles.css`, `system-recorder`, `whisper`, and `fvad.wasm` (the bundled WebRTC-VAD module; a missing copy degrades gracefully) attached. (You can also trigger it manually via *Actions → Release → Run workflow*.)

## Attribution

Meeting Copilot builds on generously-licensed open-source work:

- Base project and dual-channel ScreenCaptureKit recorder + Google Calendar integration: **[System Recording](https://github.com/yut0takagi/obsidian-system-recording)** by **Yuto Takagi** (0BSD).
- Meeting agenda sidebar: adapted from **[Meetings Plus](https://github.com/jabaho9523/obsidian-meetings-plus)** by **Jacob Holm** (0BSD).

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for full credits.

## License

0BSD — see [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
