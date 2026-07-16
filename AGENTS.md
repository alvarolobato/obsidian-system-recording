# AGENTS.md

Working notes for AI agents (and humans) contributing to **Meeting Copilot**, an
Obsidian plugin that brings Granola-style meeting capture to Obsidian: Google
Calendar sync, dual-channel recording via a macOS Swift helper, transcription
(vendored engine, OpenAI-compatible / LiteLLM endpoints), and LLM enrichment.

Repo: `alvarolobato/obsidian-meeting-copilot`. Platform: macOS only (the
recorder helper captures system audio with a Core Audio process tap on macOS
14.4+, ScreenCaptureKit on older releases).

## Repository layout

- `src/` — plugin TypeScript. Entry point `src/main.ts`.
  - `src/calendar/` — Google Calendar API + OAuth (`googleOAuth.ts`), scheduler.
  - `src/notes/` — meeting-note creation, folder resolution, transcript/enriched blocks, dashboard.
  - `src/transcribe/` — transcription orchestrator + **vendored** engine under `src/transcribe/vendor/` (see below).
  - `src/enrich/` — enrichment prompts.
  - `src/detect/` — meeting detection (Zoom/Meet probes).
  - `src/ui/` — agenda sidebar view and modals.
  - `src/i18n/` — localization; **English is the base language** (`en.ts`). UI strings go through `t()`.
- `swift-helper/` — the `SystemRecorder` Swift package (dual-channel audio capture). Built into the `system-recorder` binary shipped with the plugin.
  - System audio: `SystemAudioProcessTap.swift` (Core Audio process tap + private aggregate device, macOS 14.4+) with `AudioCaptureManager.startSystemStream` (ScreenCaptureKit) as the pre-14.4 / failure fallback. Mic: `AVAudioEngine`. Both feed `AudioMixer` (24 kHz mono, `.me`/`.them` split sidecars).
- `.github/workflows/` — `ci.yml` (PRs + pushes to main) and `release.yml` (version tags).
- `manifest.json`, `versions.json`, `styles.css`, `esbuild.config.mjs`.

## Prerequisites

- Node.js (use the version pinned in CI; `actions/setup-node@v5`).
- Xcode / Swift toolchain (for the recorder helper, macOS only).
- `npm install` (or `npm ci`) once per worktree.

## Build, test, lint

```bash
npm run build        # tsc -noEmit typecheck + esbuild production bundle -> main.js
npm run build:swift  # swift build -c release -> swift-helper/.build/release/SystemRecorder
npm run build:all    # swift then JS
npm run lint         # eslint .
npm test             # vitest run
```

**Before opening or updating a PR, all of these must pass:** `npm run lint`,
`npm test`, `npm run build`. If the change touches `swift-helper/`, also run
`npm run build:swift` (CI builds it on a macOS runner).

There is no separate `typecheck` script — `npm run build` runs `tsc -noEmit`
first, so a clean build is the typecheck.

## Branch / worktree workflow

Use **one git worktree per branch/PR** so multiple efforts don't clash and the
main checkout stays on `main`. Worktrees live as sibling folders of the main
repo (e.g. `../mc-<topic>`).

```bash
git fetch origin
git worktree add -b fix/my-thing ../mc-my-thing origin/main
cd ../mc-my-thing && npm ci
# ...work, commit, push...
```

Clean up merged worktrees:

```bash
git worktree remove ../mc-my-thing
git worktree prune
git branch -d fix/my-thing   # after the PR merges
```

## Pull request & review process

This is the standard end-to-end flow for a non-trivial change (the notification
unification in #82 / PR followed it):

1. **File an issue with the detailed plan first.** Do a comprehensive analysis
   (root causes, code map, acceptance criteria) and open a GitHub issue with the
   full plan before writing code. It anchors the PR and gives reviewers the
   "why". Use a HEREDOC / `--body-file` for the body.
2. Branch off the latest `origin/main` in a **dedicated worktree** (one per
   PR — see above).
3. Implement, keeping changes focused. Prefer pure, injectable helpers so logic
   is unit-testable without Electron/Obsidian; add/adjust `vitest` tests for
   every logic change.
4. Ensure lint + tests + build are green (`npm run lint && npm test && npm run build`).
5. Open a PR with a Summary + Test plan (use a HEREDOC for the body) and link
   the issue (`Closes #<n>`).
6. **Review cycles** (the norm for non-trivial PRs):
   - **Copilot** review — request it on the PR (`gh pr edit <n> --add-reviewer @copilot`,
     or the API) for a first pass.
   - An **independent Opus review with clean context** — run it as a fresh
     agent/subagent that only sees the PR diff, so it isn't biased by the
     implementation chat. A second, deeper pass.
   - Address **every** finding; push fixes as new commits (don't force-push
     unless asked).
   - **Reply to each review comment** explaining the fix (or why it's a
     non-issue) and **resolve the thread** once handled
     (`gh api ... /pulls/<n>/comments` to read; resolve via the GraphQL
     `resolveReviewThread` mutation or the UI).
7. Re-run reviews until clean, then get it merge-ready (green CI, no open
   threads). Merge (squash) **only when the user asks**.

Never create commits or push unless requested.

### Reading PR feedback with `gh`

```bash
gh pr view <n> --json title,state,mergeable,mergeStateStatus,body
gh api repos/alvarolobato/obsidian-meeting-copilot/pulls/<n>/comments
gh api repos/alvarolobato/obsidian-meeting-copilot/pulls/<n>/reviews
```

## Resolving conflicts / updating a branch with main

- Prefer `git merge origin/main` into the branch over `git rebase` when a rebase
  produces **cascading conflicts** (each replayed commit re-conflicting in the
  same region). A single merge resolution is usually far cleaner and reaches the
  same up-to-date state. Rebase is fine when it's clean.
- After resolving, always re-run lint + tests + build before pushing.

## Local deploy to the Obsidian vault (for manual testing)

Dev vault plugin dir: `<vault>/.obsidian/plugins/meeting-copilot/`
(current dev vault: `/Users/alobato/git/notes/.obsidian/plugins/meeting-copilot/`).

Use the `deploy:local` script — it handles the binary-hash gotcha automatically:

```bash
npm run deploy:local            # JS/CSS-only change; reuse the vault's binary
npm run deploy:local -- --swift # swift-helper/ changed; rebuild + deploy the binary too
```

Override the target with `VAULT_PLUGIN_DIR=/path/to/vault/.obsidian/plugins/meeting-copilot`.

After deploying: **reload the plugin** in Obsidian (toggle off/on, or restart).

**Helper CLI skew warning:** plain `deploy:local` re-pins the vault's *existing*
binary, so new plugin JS runs against an old helper. An old helper silently
ignores flags it doesn't know (e.g. `--format`), which for compressed
recordings means WAV bytes written to a `.m4a` path and `.me.wav` sidecars the
plugin won't discover. If the plugin↔helper CLI contract changed since the
vault's binary was built, deploy with `--swift`. Release users are unaffected
(provisioning pins the binary per release).

### Why the script exists (the binary-hash gotcha)

The plugin verifies the `system-recorder` binary against `EXPECTED_SHA256` in
`src/binary.ts`. On `main` that value is a **placeholder** — `release.yml`
re-pins it at tag time from the binary it actually builds and ships, so only
*released* bundles are self-consistent. A plain local `npm run build` bundles
the placeholder, which matches neither the binary in your vault nor the release
asset it then tries to download → **"Recorder helper failed verification"**, on
a re-download loop every load.

`deploy-local.mjs` avoids this by:

1. computing the sha of the binary being deployed (the vault's current one, or a
   freshly built one with `--swift`),
2. pinning that sha into `src/binary.ts` for this build only,
3. running `npm run build` (baking the correct hash into `main.js`),
4. **restoring `src/binary.ts`** (in a `finally`, so the worktree stays clean),
5. copying `main.js` / `manifest.json` / `styles.css` (and the binary with
   `--swift`) into the vault — **never `data.json`** (it holds the user's
   settings; OAuth tokens + client secret live in per-vault localStorage).

Do **not** commit a locally pinned `EXPECTED_SHA256` — the sha is machine/build
specific and CI owns that value for releases.

**Screen Recording permission (macOS/TCC):** with `--swift` the binary's code
hash changes, so macOS may treat it as new and require re-granting permission.
If recording starts then immediately stops with a permission error, re-approve
Obsidian under System Settings → Privacy & Security → Screen Recording and
restart Obsidian.

**Screen Recording permission (macOS/TCC):** replacing the `system-recorder`
binary changes its code hash, so macOS may treat it as new and require
re-granting permission. If recording starts then immediately stops with a
permission error, re-approve Obsidian under System Settings → Privacy &
Security → Screen Recording and restart Obsidian.

## Releases

Releases are cut by pushing a semver tag; `release.yml` builds everything on a
macOS runner, pins the freshly built binary's sha into the bundle, and publishes
a GitHub Release with `main.js`, `manifest.json`, `styles.css`, and
`system-recorder`.

```bash
git tag -a 0.2.0 -m "0.2.0"
git push origin 0.2.0
```

`release.yml` also syncs `manifest.json` / `package.json` / `versions.json` to
the tag. `ci.yml` runs typecheck/lint/test/build on PRs and pushes to `main`,
plus a macOS job that builds the Swift helper. Keep GitHub Action versions
current (e.g. `actions/checkout@v5`, `actions/setup-node@v5`).

## Conventions & gotchas

- **Secrets:** Google OAuth tokens and the client secret are stored in per-vault
  Obsidian localStorage (`app.loadLocalStorage`/`saveLocalStorage`, requires
  `minAppVersion` ≥ 1.8.7), never in the synced/committed `data.json`.
  `saveSettings` strips them from `data.json` only after a *verified*
  localStorage write.
- **Vendored transcriber (`src/transcribe/vendor/`):** keep vendored files as
  pristine as possible for easy upstream updates. Our config/endpoint glue lives
  in `src/transcribe/TranscriptionService.ts` + `endpointConfig.ts`; the base
  URL / model overrides are injected via a small seam, not by rewriting vendored
  code. See `src/transcribe/vendor/VENDOR.md`.
- **System-audio capture:** the process tap (`SystemAudioProcessTap`) is a
  *private, auto-starting aggregate device* wrapping a `CATapDescription`
  (global mono mixdown, `.unmuted` so the user still hears the meeting). It's
  device-independent, so the SCK path's "an app switched the default device and
  audio went silent" recovery isn't needed here. Force the legacy path with
  `MC_DISABLE_PROCESS_TAP=1` for A/B testing.
  - **Permission:** the tap needs the **System Audio Recording** TCC grant
    (`Screen & System Audio Recording`), *not* Screen Recording. That grant is
    attributed to the responsible app (Obsidian), which macOS prompts for on
    first tap use; the CLI helper has no bundle of its own. So the
    `notifyRecordingError` screen-capture classification in `main.ts` now only
    fires on the SCK fallback.
  - **Silence = no IO (important):** a process tap delivers **no IO callbacks
    while system audio is silent** — it is *not* a continuous clock like an
    input device. So "no callbacks for N seconds" is a normal quiet meeting, not
    a failure, and can't be used for liveness. Two consequences the code handles:
    - *Timeline alignment:* the mic stream runs continuously but the tap stream
      has gaps. `deliver(...)` anchors to `AudioGetCurrentHostTime()` at
      `start()` and, on each buffer, compares `deliveredFrames` against the
      elapsed host-time; if a gap exceeds ~1.5 IO periods it backfills
      zero-filled buffers so `.them` stays wall-clock aligned with `.me`. Gaps
      are capped so a long silence can't allocate an enormous buffer.
    - *Health/recovery is event-driven, not timer-based:* there is **no**
      liveness timer. `installHealthListeners` registers Core Audio property
      listeners (`kAudioDevicePropertyDeviceIsAlive`,
      `kAudioHardwarePropertyServiceRestarted`, `kAudioTapPropertyFormat`) and
      calls `onNeedsRestart`; `AudioCaptureManager` rebuilds the tap in place
      (bounded by the shared `systemRestarts` cap) or falls back to SCK. A
      tap-creation *throw* still falls back to SCK immediately.
  - **Concurrency:** `teardown()` is guarded by an `NSLock` (idempotent), and
    `AudioCaptureManager` serializes all tap start/stop/restart/fallback work on
    its `controlQueue` so a mid-recording recovery can't race `stopCapture`.
- **i18n:** English is the base. Add UI strings to `src/i18n/en.ts` and use
  `t()`; don't hardcode user-facing strings.
- **Notification tracing (`src/util/notifLog.ts`):** off by default, gated on the
  `mc:notif-debug` localStorage flag (read at plugin load). When set it prints
  `[mc:notif] …` traces (via `console.warn`, so console-export tools capture
  them) and registers a dev-only "Debug test meeting notification" command in
  `main.ts`. Nothing ships to end users while the flag is off; changing it needs
  a plugin reload. User-facing steps live under *Debugging notifications* in the
  README.
- **Retention safety:** audio is pruned only when the owning note has the
  managed `transcript_saved` frontmatter flag (set by `insertTranscript`), never
  by sniffing the note body — a template placeholder must not cause data loss.
- **Tests:** logic lives in pure, testable functions where possible; the
  `obsidian` module is mocked in `test/obsidian-mock.ts`, and note/vault logic
  uses in-memory fakes. Add tests alongside behavior changes.
- **Commits:** small, focused, with a clear "why". Don't commit `.env` /
  credentials. Only commit/push when the user asks.
