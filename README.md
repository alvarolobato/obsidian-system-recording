# Meeting Copilot

Calendar-driven meeting notes for Obsidian on macOS: reads your Google Calendar, creates a meeting note from the invite, and records **dual-channel** audio (system audio from Zoom / Google Meet / Teams **plus** your microphone) via ScreenCaptureKit — no extra audio driver, no sidecar app.

> **Attribution.** Meeting Copilot is a fork of **[System Recording](https://github.com/yut0takagi/obsidian-system-recording)** by **Yuto Takagi** (0BSD). The dual-channel ScreenCaptureKit recorder and the Google Calendar integration come from that project. The meeting agenda sidebar is adapted from **[Meetings Plus](https://github.com/jabaho9523/obsidian-meetings-plus)** by **Jacob Holm** (0BSD). See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for full credits.

## Requirements

- macOS 13.0+ (Apple Silicon)
- Obsidian Desktop

## Features

- System-audio capture via ScreenCaptureKit (no extra driver)
- Simultaneous microphone capture (dual-channel mix)
- Google Calendar integration: upcoming events, attendees, and Meet/Zoom link extraction
- **Meeting agenda sidebar**: Granola-style "coming up / recent" list with per-row actions (create note + record, open note, transcribe, open recording, join link)
- Creates a meeting note from the invite and colocates the recording with it
- Recurring meetings organized into a per-series folder
- Ribbon button / command palette control; elapsed-time indicator in the status bar

## Installation (manual)

1. Build or download `main.js`, `manifest.json`, `styles.css`.
2. Place them in `.obsidian/plugins/meeting-copilot/`.
3. Enable **Meeting Copilot** in Settings → Community plugins.
4. On first recording, the macOS helper (`system-recorder`) is downloaded from the upstream GitHub release and verified (SHA-256), then macOS prompts for Screen Recording + Microphone permissions.

## Usage

- Click the microphone icon in the left ribbon to start/stop recording.
- Command palette (`Cmd+P`) → "Start recording" / "Stop recording".
- When a calendar meeting starts, a notice offers **"Create note and start recording"**.

## Settings

- **Recording folder** / **File name template**: for ad-hoc recordings.
- **Meetings folder**: where calendar meeting notes (and their recordings) are created.
- **Retention (days)**: how long recordings are kept.

## Development

```bash
npm install
cd swift-helper && swift build -c release && cd ..
cp swift-helper/.build/release/SystemRecorder system-recorder
npm run dev      # watch build
npm run build    # production build
npm test && npm run lint
```

## Releasing the macOS helper

The macOS helper (`system-recorder`) is **not** distributed by Obsidian's community store (only `main.js` / `manifest.json` / `styles.css` are). The plugin downloads it on first use from a GitHub release whose tag matches `manifest.json`'s `version`, and verifies it against `EXPECTED_SHA256` in [`src/binary.ts`](src/binary.ts). The download URL currently points at the upstream `yut0takagi/obsidian-system-recording` releases; if you change `version` to a tag that repo does not have, either repoint `REPO`/`EXPECTED_SHA256` in `src/binary.ts` to your own release or ship a prebuilt `system-recorder` next to `main.js`.

## License

0BSD — see [`LICENSE`](LICENSE) and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
