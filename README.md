# Meeting Copilot

A Granola-style meeting workflow for Obsidian on macOS. Meeting Copilot reads your Google Calendar, creates a note from the meeting invite, records **dual-channel** audio (system audio from Zoom / Google Meet / Teams **plus** your microphone) via ScreenCaptureKit, then transcribes and enriches the note with an AI summary and action items — no extra audio driver and no sidecar app.

## Requirements

- macOS 13.3+ (Apple Silicon)
- Obsidian Desktop
- A Google account (for calendar integration)
- One OpenAI-compatible endpoint (configured as a single base URL in settings) used for both transcription and enrichment. OpenAI and LiteLLM work for both. **Ollama** has no `/audio/transcriptions` endpoint, so it works for enrichment only. **Azure** requires the `/openai/v1` OpenAI-compatible surface — the classic deployment-path format won't work.

## Features

- **Dual-channel recording** — system audio via ScreenCaptureKit **plus** microphone, mixed into one file (no extra driver, no sidecar).
- **Google Calendar integration** — upcoming events, attendees, and Meet/Zoom link extraction, built in (no separate calendar plugin required).
- **Meeting agenda sidebar** — a "coming up / recent" list with per-row actions: create note + record, open note, transcribe, enrich, open recording, join link.
- **Automatic notes** — creates a meeting note from the invite, colocates the recording with it, and files recurring meetings into a per-series folder.
- **Transcript → note automation** — when a recording stops it can transcribe automatically and drop a collapsible transcript at the bottom of the note.
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

> Transcription and enrichment share one endpoint configured in Meeting Copilot's own settings. The endpoint must be OpenAI-compatible and serve both `/audio/transcriptions` and `/chat/completions`. OpenAI and a LiteLLM proxy work for both. Ollama works for enrichment only (no `/audio/transcriptions`). Azure works only via the newer OpenAI-compatible surface (`/openai/v1`), not the classic deployment-path format. The transcription engine itself is bundled (vendored from [AI Transcriber](https://github.com/mssoftjp/obsidian-ai-transcriber), MIT); AI Transcriber does **not** need to be installed.

## Installation

**Option A — BRAT (recommended for updates):** install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) community plugin, then *Add beta plugin* with `alvarolobato/obsidian-meeting-copilot`. BRAT installs from the latest [GitHub release](https://github.com/alvarolobato/obsidian-meeting-copilot/releases) and keeps it up to date.

**Option B — manual:**

1. From the [latest release](https://github.com/alvarolobato/obsidian-meeting-copilot/releases/latest), download `main.js`, `manifest.json`, `styles.css` (and optionally the `system-recorder` helper).
2. Copy them into `.obsidian/plugins/meeting-copilot/` in your vault.
3. In Obsidian, enable **Meeting Copilot** under *Settings → Community plugins*.

Then, regardless of method:

4. Optionally install the plugins from the table above (Dataview, Tasks).
5. On your first recording, the macOS helper (`system-recorder`) is downloaded from the matching release and verified (SHA-256) if you didn't already copy it in. macOS then prompts for **Screen Recording** and **Microphone** permissions — grant both, then fully quit and reopen Obsidian. (Apple Silicon / arm64 only.)

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

In *Settings → Meeting Copilot → AI endpoint (shared)*, set the **API base URL** and **API key** for your OpenAI-compatible endpoint. These are used for **both** transcription and enrichment.

### Transcription

In *Settings → Meeting Copilot → Transcription*, pick a **Transcription model** (`gpt-4o-transcribe` is most accurate; `whisper-1-ts` adds word timestamps), a language, and optionally enable **AI post-processing** and a **custom dictionary** (one `misheard => correct` rule per line). Transcription runs headlessly — no dialog — when you transcribe a recording or when *Auto-transcribe when recording stops* is on.

### AI enrichment

In *Settings → Meeting Copilot → AI enrichment*, enable enrichment, then click **Test connection** (under the model row) to load the available chat models from the shared endpoint and pick one from the dropdown.

## Usage

- Click the microphone icon in the left ribbon to start/stop an ad-hoc recording.
- Open the **meeting agenda** sidebar to create a note + record, transcribe, enrich, or join a meeting for any calendar event.
- When a calendar meeting starts, a notice offers **"Create note and start recording"**.
- Right-click a meeting note (or use the editor menu) to run the same actions — transcribe, enrich, open recording, join link.

## Settings

- **Google Calendar integration**: Client ID / secret, authentication, target calendar, agenda look-ahead / look-back, exclusion keywords.
- **Recording folder** / **File name template**: for ad-hoc recordings.
- **One-off meetings folder** / **New series folder**: `{{year}}`/`{{month}}`/`{{series}}`/`{{title}}`/`{{date}}` templates for where calendar meeting notes (and their recordings) are created. A recurring meeting's later occurrences follow wherever its folder ends up, even if you move it.
- **Handle 1:1s separately** / **One-on-one folder**: file 1:1s (exactly one other attendee) into their own per-person folder instead of the rules above.
- **Ad-hoc meetings folder**: where unplanned (ad-hoc or detected) meeting notes land.
- **Recording retention (days)**: recordings older than this are trashed on startup and via *Clean up old recordings*; `0` keeps them forever. A recording is pruned only when the plugin has durably saved the transcript into its owning meeting note — so notes without the transcript captured (e.g. enriched with *Insert transcript* off), orphan/ad-hoc recordings, and unrelated audio are never deleted.
- **AI endpoint (shared)**: OpenAI-compatible base URL + API key used for both transcription and enrichment.
- **Transcription**: model, language, voice-activity detection, AI post-processing, custom dictionary, and **Auto-transcribe when recording stops** (headless — no dialog).
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

### Releasing

Releases are automated by [`.github/workflows/release.yml`](.github/workflows/release.yml). To cut a release, push a version tag (no `v` prefix, matching the target `manifest.json` version):

```bash
git tag 1.0.5 && git push origin 1.0.5
```

On an Apple-Silicon runner the workflow lints/tests, syncs `manifest.json` / `versions.json` to the tag, builds the Swift helper, pins its SHA-256 into the build, builds the plugin, and publishes a GitHub release with `main.js`, `manifest.json`, `styles.css`, and `system-recorder` attached. (You can also trigger it manually via *Actions → Release → Run workflow*.)

## Attribution

Meeting Copilot builds on generously-licensed open-source work:

- Base project and dual-channel ScreenCaptureKit recorder + Google Calendar integration: **[System Recording](https://github.com/yut0takagi/obsidian-system-recording)** by **Yuto Takagi** (0BSD).
- Meeting agenda sidebar: adapted from **[Meetings Plus](https://github.com/jabaho9523/obsidian-meetings-plus)** by **Jacob Holm** (0BSD).

See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for full credits.

## License

0BSD — see [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
