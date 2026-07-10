# Third-party notices

Meeting Copilot incorporates and adapts code from the following projects. We are
grateful to their authors. All are permissively licensed; attribution is provided
here as a courtesy (0BSD does not legally require it).

## System Recording (base project)

- Author: Yuto Takagi
- Source: https://github.com/yut0takagi/obsidian-system-recording
- License: 0BSD

Meeting Copilot is a fork of System Recording. The dual-channel ScreenCaptureKit
recorder (`swift-helper/`, `src/binary*.ts`, `src/recorder*`), the Google Calendar
integration (`src/calendar/`), and the core plugin scaffolding originate from this
project.

```
Copyright (C) 2020-2025 by Dynalist Inc.

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT,
OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA
OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

## Meetings Plus (agenda sidebar view)

- Author: Jacob Holm
- Source: https://github.com/jabaho9523/obsidian-meetings-plus
- License: 0BSD

The meeting agenda sidebar view is adapted from Meetings Plus. Specifically, the
following files carry adapted code (and each has an attribution header):

- `src/ui/agenda/MeetingAgendaView.ts` (agenda layout, day grouping, empty-run
  collapsing, "earlier today" section) — from `src/ui/MeetingsPlusView.ts`
- `src/ui/agenda/components/statusHeader.ts` — from `src/ui/components/status-header.ts`
- `src/ui/agenda/components/datePicker.ts` — from `src/ui/components/date-picker.ts`
- `src/ui/agenda/components/meetingRow.ts` — from `src/ui/components/meeting-row.ts`
- `src/ui/agenda/components/currentMeeting.ts` — from `src/ui/components/current-meeting.ts`
- `src/util/events.ts` — from `src/util/events.ts`
- `src/calendar/meetingUrl.ts` (provider URL regexes) — from `src/calendar/parser.ts`
- The `meeting-copilot-*` rules in `styles.css` — from Meetings Plus `styles.css`

```
Meetings Plus is distributed under the 0BSD license, which imposes no
attribution requirement; this credit is provided as a courtesy.
```

## AI Transcriber (vendored transcription engine)

- Author: Musashino Software
- Source: https://github.com/mssoftjp/obsidian-ai-transcriber
- License: MIT

The transcription engine under `src/transcribe/vendor/` is vendored from AI
Transcriber (chunking, VAD, Whisper/GPT-4o clients, hallucination/repetition
cleaners, transcript merge, dictionary correction). The files are kept pristine
except for a small documented set of endpoint patches — see `VENDOR.md`.

```
MIT License

Copyright (c) 2025 Musashino Software

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Day Planner (reference only)

- Author: Ivan Lednev
- Source: https://github.com/ivan-lednev/obsidian-day-planner
- License: MIT

Used only as a reference for the Obsidian `registerView` + right-sidebar
activation pattern. No source code was copied.
