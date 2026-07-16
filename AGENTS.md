# AGENTS.md

Working notes for AI agents (and humans) contributing to **Meeting Copilot**, an
Obsidian plugin that brings Granola-style meeting capture to Obsidian: Google
Calendar sync, dual-channel recording via a macOS Swift helper, transcription
(remote OpenAI-compatible / LiteLLM endpoints **or** local on-device whisper.cpp),
and LLM enrichment.

Repo: `alvarolobato/obsidian-meeting-copilot`. Platform: macOS only (the
recorder helper uses ScreenCaptureKit / Core Audio).

## Repository layout

- `src/` — plugin TypeScript. Entry point `src/main.ts`.
  - `src/calendar/` — Google Calendar API + OAuth (`googleOAuth.ts`), scheduler.
  - `src/notes/` — meeting-note creation, folder resolution, transcript/enriched blocks, dashboard.
  - `src/transcribe/` — backend-agnostic orchestrator (`TranscriptionService.ts`) behind the `TranscriptionBackend` seam (`backend.ts`); the remote engine (`OpenAICompatibleBackend.ts` + **vendored** engine under `src/transcribe/vendor/`, see below) and the local engine (`WhisperCppBackend.ts` + model registry `localModels.ts`).
  - `src/enrich/` — enrichment prompts.
  - `src/detect/` — meeting detection (Zoom/Meet probes).
  - `src/ui/` — agenda sidebar view and modals.
  - `src/i18n/` — localization; **English is the base language** (`en.ts`). UI strings go through `t()`.
- `swift-helper/` — the `SystemRecorder` Swift package (dual-channel audio capture + the `transcribe` subcommand in `Transcribe.swift`, which drives whisper.cpp over Metal and streams NDJSON). Built into the `system-recorder` binary; links whisper.cpp's **dynamic** `whisper.framework`, so the `whisper` dylib ships in the `whisper.framework/Versions/Current/whisper` layout next to the binary.
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

1. Branch off the latest `origin/main` in a fresh worktree.
2. Implement, keeping changes focused. Add/adjust `vitest` tests for logic changes.
3. Ensure lint + tests + build are green.
4. Open a PR with a Summary + Test plan (use a HEREDOC for the body).
5. **Review cycles** (this is the norm for non-trivial PRs):
   - **Copilot** review (`gh` auto-review) — a first pass.
   - An **independent Opus review** — a second, deeper pass.
   - Address every finding; push fixes as new commits (don't force-push unless asked).
6. Re-run reviews until clean, then merge (squash) once CI is green.

Only merge when the user asks. Never create commits or push unless requested.

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

**Whisper dylib (`--swift`):** because the helper links `whisper.framework`
dynamically, `deploy-local.mjs` with `--swift` also stages the built `whisper`
dylib into the **exact release layout** —
`whisper.framework/Versions/Current/whisper` as a real file (not the SwiftPM
build's absolute symlink) — so the deployed plugin is self-contained and matches
what `AssetProvisioner` writes for shipped users. The helper resolves it via an
`@loader_path` rpath at launch, so a missing/misplaced dylib fails dyld **before
`main()`** — breaking recording, not just transcription. Unlike the binary's
`EXPECTED_SHA256` (a `main` placeholder that `release.yml` **re-pins** at tag
time), `EXPECTED_WHISPER_SHA256` / `WHISPER_DYLIB_SIZE` in `src/binary.ts` are
**fixed committed constants** for the pinned XCFramework: `release.yml` only
*verifies* the freshly built dylib against them and fails loudly on a mismatch,
so refresh both by hand when you bump the XCFramework (never a `deploy-local`
placeholder). Local Whisper **models** are downloaded on demand into the
plugin's `models/` dir and pinned by SHA-256 in `localModels.ts`; they're never
bundled or deployed.

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
macOS runner, pins the freshly built binary's sha into the bundle, verifies the
built `whisper` dylib against the pinned `EXPECTED_WHISPER_SHA256` **and**
`WHISPER_DYLIB_SIZE` (an XCFramework bump that refreshes only one would fail the
build rather than ship an unverified dylib), and publishes a GitHub Release with
`main.js`, `manifest.json`, `styles.css`, `system-recorder`, `whisper`, and
`fvad.wasm` (the bundled WebRTC-VAD module — a missing copy degrades gracefully).

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
  in `src/transcribe/OpenAICompatibleBackend.ts` + `endpointConfig.ts`; the base
  URL / model overrides are injected via a small seam, not by rewriting vendored
  code. See `src/transcribe/vendor/VENDOR.md`.
- **Transcription backend seam (`src/transcribe/backend.ts`):** transcription
  goes through a pluggable `TranscriptionBackend` (`transcribe(request) =>
  JobResult[]` + `validateConfig()`). `TranscriptionService.ts` is a
  backend-agnostic *orchestrator* (diarized job construction, capability-miss
  classification, merge, probe invalidation); the OpenAI-compatible engine —
  vendored controller, process-global endpoint seam, serial queue, `PLAIN::`
  key contract, pre-gate encoding, engine-progress band — is fully contained in
  `OpenAICompatibleBackend`. The serial queue is module-scoped in
  `OpenAICompatibleBackend` (the endpoint globals it guards are process-wide),
  so building a fresh backend per transcription is safe.
- **Local backend (`src/transcribe/WhisperCppBackend.ts`, issue #34):** drops in
  against the same interface. Runs *all* jobs in one helper process (manifest
  lists them) so the model loads once; owns the NDJSON line protocol, per-job
  progress slicing, and SIGTERM cancellation. It has **no** module serial queue
  (no process-global to guard) and does **not** forward `speechWindows` (no
  upload to trim; the diarized merge drops out-of-window/hallucinated segments
  after the fact). The 25 MB / chunk-count limits are **remote-only** — never
  port them here; whisper.cpp handles arbitrary length via its 30 s windows.
  `buildLocalBackend()` in `main.ts` co-provisions the binary + `whisper` dylib
  (`ensureHelperRuntime()`, shared with recording/device-listing) and the model,
  then constructs the backend; `localFallbackToRemote` retries a failed local
  run remotely (non-diarized), never on an abort.
- **i18n:** English is the base. Add UI strings to `src/i18n/en.ts` and use
  `t()`; don't hardcode user-facing strings.
- **Retention safety:** audio is pruned only when the owning note has the
  managed `transcript_saved` frontmatter flag (set by `insertTranscript`), never
  by sniffing the note body — a template placeholder must not cause data loss.
- **Tests:** logic lives in pure, testable functions where possible; the
  `obsidian` module is mocked in `test/obsidian-mock.ts`, and note/vault logic
  uses in-memory fakes. Add tests alongside behavior changes.
- **Commits:** small, focused, with a clear "why". Don't commit `.env` /
  credentials. Only commit/push when the user asks.
