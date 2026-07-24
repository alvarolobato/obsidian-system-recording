import { Component, FileSystemAdapter, MarkdownRenderer, MarkdownView, Menu, normalizePath, Notice, Platform, Plugin, setIcon, TFile } from "obsidian";
import {
    DEFAULT_SETTINGS,
    inferSttApiType,
    migrateSettings,
    STT_MODELS,
    SttApiType,
    SystemRecordingSettings,
    SystemRecordingSettingTab,
} from "./settings";
import {
    Recorder,
    RecorderStatus,
    RecordingFormat,
    listInputDevices,
    type InputDevice,
} from "./recorder";
import {
    AssetProvisioner,
    BinaryProvisioner,
    EXPECTED_FVAD_SHA256,
    EXPECTED_WHISPER_SHA256,
    FVAD_WASM_SIZE,
    fvadWasmUrl,
    WHISPER_DYLIB_SIZE,
    whisperDylibUrl,
} from "./binary";
import { describeVersion } from "./buildInfo";
import { awaitIndexedFile } from "./util/awaitIndexedFile";
import { findByPathCaseInsensitive } from "./util/caseInsensitivePath";
import {
    assetNodeDeps,
    nodeDeps,
    resolveBinaryPath,
    resolveFvadWasmPath,
    resolveModelPath,
    resolveWhisperDylibPath,
    whisperCppNodeDeps,
} from "./binary-runtime";
import {
    LOCAL_MODELS,
    localModelSpec,
    type LocalModelSpec,
} from "./transcribe/localModels";
import * as path from "path";
import * as fs from "fs";
import { GoogleOAuth, type StoredTokens } from "./auth/googleOAuth";
import { listEvents } from "./calendar/googleCalendar";
import { parseKeywords } from "./calendar/eventFilter";
import { CalendarScheduler, GRACE_MS, ScheduledEvent } from "./calendar/scheduler";
import { eventEndStopAction } from "./calendar/eventEnd";
import { actionNotice, multiActionNotice, NoticeAction } from "./ui/actionNotice";
import {
    ADHOC_ID_PREFIX,
    createMeetingNote,
    dropRecordingLink,
    effectiveNoteTemplate,
    effectiveTitlePattern,
    findMeetingNoteForAudio,
    folderOf,
    insertTranscript,
    linkRecording,
    MeetingEventInfo,
    MeetingNoteConfig,
    normalizeFolderPathOrEmpty,
    parseStampDate,
    recordingLinkTarget,
    recordingLinkTargets,
    sanitizeName,
    scanMeetingNotes,
    stripTranscript,
    templateStaticRoot,
    TRANSCRIPT_SEGMENT_SEPARATOR,
    transcriptAtBottom,
    upsertSection,
} from "./notes/meetingNote";
import {
    extractSection,
    extractTranscript,
    HIDE_AI_CLASS,
    withEnrichedBlock,
} from "./notes/enrichedBlock";
import {
    extractActionItems,
    extractFollowUps,
    extractManualActionItems,
    refreshActionItems,
    stampCreatedDate,
    stripTaskMeta,
} from "./notes/actionItems";
import { normalizeManualNotes } from "./notes/manualNotes";
import {
    ACTIONS_BLOCK_LANG,
    ATTENTION_BLOCK_LANG,
    buildDashboardBlock,
    DASHBOARD_CSS_CLASS,
    FOLLOWUPS_BLOCK_LANG,
    PAST_BLOCK_LANG,
    UPCOMING_BLOCK_LANG,
    withDashboardBlock,
} from "./notes/dashboard";
import { computeAttention, type AttentionInput } from "./notes/attention";
import {
    meetingRows,
    type MeetingDirection,
    normalizePageSize,
    PAGE_SIZE_OPTIONS,
    paginate,
    type DashboardMeetingInput,
    type Page,
} from "./notes/dashboardMeetings";
import {
    countTasks,
    mergeGroupsByPath,
    parseNoteTasks,
    sortActionNoteGroups,
    splitByHorizon,
    taskAgeDays,
    type ActionNoteGroup,
    type ActionTask,
} from "./notes/dashboardActions";
import type { GCalEvent } from "./calendar/googleCalendar";
import { findExpiredRecordings, underFolder } from "./recordings/retention";

/** Note section that holds personal action-item checkboxes (obsidian-tasks compatible). */
const ACTION_ITEMS_HEADING = "## Action items";
/** Note section that holds meeting-wide follow-up checkboxes. */
const FOLLOW_UPS_HEADING = "## Follow-ups";
import { chatComplete, ChatAbortError } from "./enrich/llm";
import { isPartialTranscript } from "./transcribe/partial";
import { stripHallucinatedLines } from "./transcribe/hallucination";
import {
    initTranscribeEngine,
    isDiarizationCancelled,
    shouldInvalidateProbe,
    transcribeAudio,
    transcribeDiarized,
    type TranscribeConfig,
} from "./transcribe/TranscriptionService";
import { OpenAICompatibleBackend } from "./transcribe/OpenAICompatibleBackend";
import { WhisperCppBackend } from "./transcribe/WhisperCppBackend";
import type { TranscriptionBackend } from "./transcribe/backend";
import { canSeparateSpeakers } from "./transcribe/sttModel";
import { probeKey } from "./transcribe/probe";
import {
    RECORDING_FORMATS,
    baseRecordingCandidatesOf,
    isSidecarPath,
    parseSpeechWindows,
    sidecarPathsFor,
} from "./transcribe/sidecar";
import { preferWindows, pregateSources, type SpeechWindows } from "./transcribe/diarize";
import { computeSpeechWindows } from "./transcribe/vadWindows";
import { parseDictionary } from "./transcribe/dictionary";
import type { TranscriptionModel } from "./transcribe/vendor/ApiSettings";
import {
    ADHOC_TITLE_PROMPT_SUFFIX,
    effectiveEnrichPrompt,
    ENRICH_SYSTEM_PROMPT,
    extractEmbeddedTitle,
    fillPrompt,
} from "./enrich/prompt";
import {
    cleanSuggestedTitle,
    shouldSuggestAdhocTitle,
} from "./enrich/adhocTitle";
import { RenameModal } from "./ui/renameModal";
import { t } from "./i18n";
import { TypedEventBus } from "./util/events";
import {
    AgendaMeeting,
    buildNoteIndex,
    toAgendaMeeting,
    toMeetingInfo as agendaToMeetingInfo,
} from "./ui/agenda/agendaModel";
import {
    AgendaViewEvents,
    AgendaViewHost,
    MeetingAgendaView,
    VIEW_TYPE_AGENDA,
    AGENDA_ICON,
} from "./ui/agenda/MeetingAgendaView";
import {
    populateMeetingMenu,
    RowHandlers,
} from "./ui/agenda/components/meetingRow";
import { registerIcons, RECORD_ICON } from "./ui/icons";
import {
	notifyOs,
	requestNotificationPermission,
	OsNotificationAction,
} from "./ui/osNotification";
import {
	startDualChannelPrompt,
	DualChannelController,
	InAppHandle,
} from "./ui/dualChannelPrompt";
import { notifLog, notifDebugEnabled } from "./util/notifLog";
import { decideWindowFocused, BrowserWindowState } from "./util/windowFocus";
import {
    QueueItem,
    QueueSnapshot,
    TaskCancelledError,
    TaskKind,
    TaskQueue,
} from "./transcribe/queue";
import { MeetingDetector } from "./detect/meetingDetector";
import { googleMeetActive, zoomInMeeting } from "./detect/probe";
import { execFile } from "child_process";

/**
 * How a transcribe run treats speaker separation:
 *   - "auto":     respect the speaker-separation setting (auto-transcribe path)
 *   - "diarized": force the separated pass (fall back to the joint track if
 *                 no separate tracks were recorded)
 *   - "mixed":    always transcribe the single joint track
 */
type TranscribeMode = "auto" | "diarized" | "mixed";

/**
 * The outcome of transcribing one recording (take) to text, before any note
 * write. "text" carries the ready-to-insert transcript; the rest are the
 * no-transcript outcomes each caller handles differently (a fresh single take
 * may discard an "empty" as silence; a multi-take rebuild just skips it). User
 * cancellation is not modelled here — it throws so the queue rejects.
 */
type TranscribeTakeResult =
    | { kind: "text"; text: string }
    | { kind: "empty" }
    | { kind: "partial" }
    | { kind: "error"; message: string };

/**
 * Cap on how long the diarized pass waits for the (optional, ~20 KB) fvad.wasm
 * fetch before proceeding with the RMS fallback. The download is normally
 * sub-second (and a no-op once present), but `requestUrl` can't be aborted
 * mid-flight, so a stalled connection must not hang transcription — after this
 * it continues in the background for the next run.
 */
const FVAD_PROVISION_TIMEOUT_MS = 15_000;

export default class SystemRecordingPlugin extends Plugin {
    settings: SystemRecordingSettings;
    private recorder = new Recorder();
    private provisioner = new BinaryProvisioner(nodeDeps());
    private modelProvisioner = new AssetProvisioner(assetNodeDeps());
    private starting = false;
    /** Dedupe identical capture warnings so a flapping device can't spam. */
    private lastWarningMessage: string | null = null;
    private lastWarningAt = 0;
    private statusBarEl: HTMLElement | null = null;
    private statusTimeout: number | null = null;
    private durationInterval: number | null = null;
    private recordingStartTime: number | null = null;
    /** Hover popover listing the task queue (running + next few waiting), with per-item cancel. */
    private queuePopoverEl: HTMLElement | null = null;
    /** True while the pointer is over the status bar item or the popover (keeps it shown). */
    private statusHovered = false;
    /**
     * Deferred popover teardown: leaving the status bar (or the popover) hides it
     * after a short grace so the pointer can cross the small gap between them —
     * the popover is interactive now (per-item cancel), so it must survive the
     * hand-off instead of vanishing mid-reach.
     */
    private popoverHideTimer: number | null = null;
    /** The recording timer text span, and the small transcription-count badge beside it. */
    private recTimeEl: HTMLElement | null = null;
    private recQueueEl: HTMLElement | null = null;
    /** How many waiting jobs the hover popover lists before collapsing the rest into "+N more". */
    private static readonly QUEUE_POPOVER_LIMIT = 5;
    private ribbonIconEl: HTMLElement | null = null;
	private oauth = new GoogleOAuth(
		{
			getCredentials: () => {
				const id = this.settings.googleClientId.trim();
				const secret = this.settings.googleClientSecret.trim();
				return id && secret ? { client_id: id, client_secret: secret } : null;
			},
			getTokens: () => this.settings.googleTokens,
			setTokens: async (tokens) => {
				this.settings.googleTokens = tokens;
				await this.saveSettings();
			},
		},
		() => this.onCalendarAuthExpired()
	);
	private scheduler: CalendarScheduler | null = null;
	/** True once the refresh token died; suppresses the looping calendar-error notice until reconnect. */
	private authExpired = false;
	/** Tier 1 meeting detector + its poll interval id (macOS only). */
	private detector: MeetingDetector | null = null;
	private detectorIntervalId: number | null = null;
	/** Note the in-progress recording belongs to, so we can link it back on stop. */
	private currentMeetingNotePath: string | null = null;
	/**
	 * Live reference to that note. Preferred over the path on stop so renaming
	 * the note mid-recording (Obsidian updates `TFile.path`) still links back.
	 */
	private currentMeetingNote: TFile | null = null;
	/** Calendar event id of the in-progress meeting recording, for agenda state. */
	private currentRecordingEventId: string | null = null;
	/** End time (epoch ms) of the calendar event being recorded, for auto-stop/sleep recovery. Null for ad-hoc. */
	private currentRecordingEventEnd: number | null = null;
	/** Vault-relative path of the in-progress recording, protected from retention. */
	private currentRecordingPath: string | null = null;
	/**
	 * Visible, serial task queue (running + waiting) for all long-running
	 * background work — transcription and enrichment — with per-item cancellation
	 * and a transcribe→enrich dependency pipeline (issue #96).
	 */
	private taskQueue = new TaskQueue((s) =>
		this.renderQueueStatus(s)
	);
	/**
	 * Last progress percent for the running transcription, so queue-change
	 * repaints (which fire between the sparse progress ticks) can keep showing
	 * it instead of dropping back to a percent-less label.
	 */
	private runningProgress: { id: string; pct: number } | null = null;
	/** Calendar event ids whose meeting link was already auto-opened, so it opens once. */
	private openedLinkEventIds = new Set<string>();
	/**
	 * Meeting prompts currently on screen, keyed by meeting (calendar event id,
	 * or a detection key). Each is an exclusive-channel controller (in-app Notice
	 * when focused, OS notification when not — never both). A new prompt
	 * supersedes *all* live prompts so surfaces don't stack.
	 */
	private meetingNotices = new Map<string, DualChannelController>();
	/**
	 * The current "meeting ended — stop recording?" prompt, if any. A recording
	 * never stops on its own (unless the user opted into calendar auto-stop), so
	 * the end of a meeting only offers to stop; we keep one reference to supersede
	 * a stale prompt and to clear it once recording actually ends.
	 */
	private stopPromptNotice: DualChannelController | null = null;
	/** Resolvers waiting for the current recording to fully stop (back-to-back chaining). */
	private stopWaiters: Array<() => void> = [];
	/**
	 * Nested count of in-flight `replaceCurrent` handoffs. Suppresses stop
	 * prompts while > 0. A refcount (not a boolean) so a concurrent
	 * startRecording that early-returns can't clear suppression for another
	 * handoff still in stopAndWait/provision/spawn.
	 */
	private replacingDepth = 0;
	/** True while a stopped recording is still being linked/handled in attachRecording. */
	private attaching = false;
	/**
	 * Pending auto-transcribe waits, keyed by the recording's vault path. Each
	 * waits for Obsidian's index to catch up to a just-written recording (index
	 * lag; see {@link awaitIndexedFile}). A manual transcribe of the same file —
	 * or plugin unload — aborts the wait so the take isn't transcribed twice.
	 */
	private pendingAutoTranscribe = new Map<string, AbortController>();
	/** Wall-clock of the previous duration tick, for sleep detection while recording. */
	private lastDurationTickAt: number | null = null;
	/** Note paths currently being offered an AI title, to prevent duplicate modals. */
	private titleSuggestingPaths = new Set<string>();
	/** One-shot startup retention sweep, cleared on unload. */
	private retentionTimeout: number | null = null;
	/** Serializes retention sweeps so the startup timer and the command can't overlap. */
	private cleanupRunning = false;
	private agendaEvents = new TypedEventBus<AgendaViewEvents>();

    async onload() {
        // Log the version + build provenance once at load (verbose console) so a
        // support report can tell an official release from a custom build. The
        // "custom build" label is intentionally left in English here (dev/support
        // log, not localized UI); the settings tab uses the localized label.
        console.debug(
            `${this.manifest.name} v${describeVersion(this.manifest.version)}`
        );
        await this.loadSettings();
        // Prime the vendored transcription engine (i18n + plugin dir).
        initTranscribeEngine(this.manifest.dir ?? null);

        // Ribbon icon
        registerIcons();
        this.ribbonIconEl = this.addRibbonIcon(
            RECORD_ICON,
            t().ribbon.toggleRecording,
            (evt) => this.onRibbonClick(evt)
        );

        // Meeting agenda sidebar view
        this.registerView(
            VIEW_TYPE_AGENDA,
            (leaf) => new MeetingAgendaView(leaf, this.agendaHost())
        );
        this.addRibbonIcon(AGENDA_ICON, t().ribbon.openAgenda, () =>
            void this.openAgenda()
        );
        this.addCommand({
            id: "open-agenda",
            name: t().commands.openAgenda,
            callback: () => void this.openAgenda(),
        });

        // Expose the same actions as the agenda list (record, transcribe,
        // enrich, links, …) from the note's editor and file context menus.
        this.registerEvent(
            this.app.workspace.on("editor-menu", (menu, _editor, info) => {
                const file = info.file;
                if (file instanceof TFile && this.isMeetingNote(file)) {
                    this.addNoteMeetingMenu(menu, file);
                }
            })
        );
        this.registerEvent(
            this.app.workspace.on("file-menu", (menu, file) => {
                if (file instanceof TFile && this.isMeetingNote(file)) {
                    this.addNoteMeetingMenu(menu, file);
                }
            })
        );

        // "Needs attention" dashboard section: meetings that haven't finished
        // the pipeline, rendered with per-row action buttons.
        this.registerMarkdownCodeBlockProcessor(
            ATTENTION_BLOCK_LANG,
            (_src, el) => {
                this.trackDashboardBlock(el, () => this.renderAttention(el));
                this.renderAttention(el);
            }
        );

        // "Upcoming"/"Past meetings" dashboard sections: paginated tables that
        // merge the vault's meeting notes with the calendar events the agenda
        // already loads (Dataview can't do that, nor interactive pagination).
        this.registerMarkdownCodeBlockProcessor(
            UPCOMING_BLOCK_LANG,
            (_src, el) => {
                this.trackDashboardBlock(el, () =>
                    void this.renderMeetingsSection(
                        el,
                        "upcoming",
                        this.blockPage(el)
                    )
                );
                void this.renderMeetingsSection(el, "upcoming");
            }
        );
        this.registerMarkdownCodeBlockProcessor(
            PAST_BLOCK_LANG,
            (_src, el) => {
                this.trackDashboardBlock(el, () =>
                    void this.renderMeetingsSection(
                        el,
                        "past",
                        this.blockPage(el)
                    )
                );
                void this.renderMeetingsSection(el, "past");
            }
        );

        // "Open action items" dashboard section: personal open tasks from
        // ## Action items, grouped by note (newest first), dense and paginated.
        this.registerMarkdownCodeBlockProcessor(
            ACTIONS_BLOCK_LANG,
            (_src, el) => {
                this.trackDashboardBlock(el, () =>
                    void this.renderActionItems(el, this.blockPage(el), true)
                );
                void this.renderActionItems(el);
            }
        );

        // "Meeting follow-ups" dashboard section: shared commitments from
        // ## Follow-ups, horizon-filtered so the list stays bounded.
        this.registerMarkdownCodeBlockProcessor(
            FOLLOWUPS_BLOCK_LANG,
            (_src, el) => {
                this.trackDashboardBlock(el, () =>
                    void this.renderFollowUps(el, this.blockPage(el), true)
                );
                void this.renderFollowUps(el);
            }
        );

        // Keep the plugin-rendered dashboard sections live: when the vault or
        // pipeline changes (recording, transcription, enrichment, note
        // creation) re-render the tracked blocks in place — restoring the
        // auto-updating the old Dataview tables had. Debounced; each block
        // keeps the page the user was on (see blockPage), disconnected ones
        // are pruned on the next pass.
        this.agendaEvents.on("changed", () => this.scheduleDashboardRefresh());

        // Status bar
        this.statusBarEl = this.addStatusBarItem();
        this.statusBarEl.addClass("system-recording-hidden");
        // Hovering the status bar reveals the queue popover with the full list.
        this.registerDomEvent(this.statusBarEl, "mouseenter", () =>
            this.setStatusHover(true)
        );
        this.registerDomEvent(this.statusBarEl, "mouseleave", () =>
            this.setStatusHover(false)
        );

        // Commands
        this.addCommand({
            id: "start-recording",
            name: t().commands.startRecording,
            callback: () => void this.startAdHocMeeting(),
        });

        this.addCommand({
            id: "stop-recording",
            name: t().commands.stopRecording,
            callback: () => this.stopRecording(),
        });

        // Settings tab
        this.addSettingTab(new SystemRecordingSettingTab(this.app, this));

		this.addCommand({
			id: "authenticate-google-calendar",
			name: t().commands.authenticateCalendar,
			callback: () => void this.authenticateCalendar(),
		});

		this.addCommand({
			id: "toggle-calendar-auto-recording",
			name: t().commands.toggleCalendarAutoRecording,
			callback: async () => {
				this.settings.calendarAutoRecord = !this.settings.calendarAutoRecord;
				await this.saveSettings();
				this.updateScheduler();
				new Notice(
					this.settings.calendarAutoRecord
						? t().notices.autoRecordEnabled
						: t().notices.autoRecordDisabled
				);
			},
		});

		this.addCommand({
			id: "enrich-meeting-note",
			name: t().commands.enrichNote,
			callback: () => void this.enrichActiveNote(),
		});

		this.addCommand({
			id: "toggle-ai-notes",
			name: t().commands.toggleAiNotes,
			callback: () => void this.toggleAiNotes(),
		});

		this.addCommand({
			id: "cleanup-old-recordings",
			name: t().commands.cleanupRecordings,
			callback: () => void this.cleanupOldRecordings(true),
		});

		this.addCommand({
			id: "create-meetings-dashboard",
			name: t().commands.createDashboard,
			callback: () => void this.createDashboard(),
		});

		this.addCommand({
			id: "cancel-transcription",
			name: t().commands.cancelTranscription,
			callback: () => this.cancelActiveTranscription(),
		});

		// Dev-only (gated on the `mc:notif-debug` localStorage flag, off in
		// shipped builds): fire a sample meeting prompt after a delay so you can
		// click away first to test the system-notification (not-focused) path.
		// Watch the DevTools console (Cmd+Opt+I) filtered by `mc:notif`.
		if (notifDebugEnabled()) {
			this.addCommand({
				id: "debug-test-notification",
				name: "Debug test meeting notification",
				callback: () => {
					notifLog(
						"debug-test-notification: scheduled (4s) — click away now to test the system notification"
					);
					new Notice(
						"Test notification in 4s — click away to test the system notification",
						4000
					);
					window.setTimeout(() => {
						notifLog("debug-test-notification: firing", {
							focused: this.isWindowFocused(),
						});
						this.promptMeeting({
							key: "debug:test",
							title: "Test meeting",
							subtitle: "Debug notification",
							meetLink: "https://example.com/meet",
							onRecord: () =>
								notifLog("debug-test-notification: onRecord picked"),
							onOpenNote: () =>
								notifLog("debug-test-notification: onOpenNote picked"),
						});
					}, 4000);
				},
			});
		}

		// Once the vault index is ready, nudge the user about recordings that
		// finished but were never transcribed (e.g. a reload mid-transcription).
		this.app.workspace.onLayoutReady(() =>
			this.notifyPendingTranscriptions()
		);

		// Sweep expired recordings shortly after startup (never blocks load).
		this.retentionTimeout = window.setTimeout(() => {
			this.retentionTimeout = null;
			void this.cleanupOldRecordings(false);
		}, 15000);

		// Restore the AI-notes visibility toggle from the last session.
		document.body.toggleClass(HIDE_AI_CLASS, this.settings.hideAiNotes);

        // Recorder callbacks
        this.recorder.onStatus = (status: RecorderStatus) =>
            this.handleStatus(status);
        this.recorder.onError = (message: string) => {
            this.notifyRecordingError(message);
            // Fatal failures (spawn error / non-zero exit) flip isRecording off
            // before invoking onError; a stderr line while still recording is
            // non-fatal, so only reset the UI when recording has truly stopped.
            // Skip while attachRecording is in flight — a late stderr/exit line
            // must not tear down state (or early-release a back-to-back waiter)
            // mid-attach; attachRecording's finally owns that teardown.
            if (!this.recorder.isRecording && !this.attaching)
                this.resetRecordingUi();
        };

		this.updateScheduler();
		requestNotificationPermission();
		this.logNotificationEnvironment();
		this.updateDetector();
		// When Obsidian becomes frontmost, swap any live OS-only prompt to the
		// in-app Notice (exclusive-channel policy).
		this.registerDomEvent(window, "focus", () => this.onPromptWindowFocused());
		// Electron can report isFocused=false while the document still has focus
		// (no window "focus" event will fire). Visibility flips also recover an
		// OS-only prompt when the user is already looking at Obsidian.
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible") this.onPromptWindowFocused();
		});
    }

	/** One-shot startup dump so "no notifications" reports have concrete context. */
	private logNotificationEnvironment(): void {
		// Skip the probing entirely when tracing is off — `notifLog` would drop it
		// anyway, so there's no reason to compute focus state or poke the (flaky)
		// Electron seam on every startup.
		if (!notifDebugEnabled()) return;
		let remoteAvailable = false;
		try {
			const req = (window as unknown as { require?: (id: string) => unknown })
				.require;
			if (typeof req === "function") {
				const electron = req("electron") as
					| { remote?: { Notification?: unknown } }
					| undefined;
				remoteAvailable = !!electron?.remote?.Notification;
			}
		} catch {
			remoteAvailable = false;
		}
		notifLog("environment", {
			isMacOS: Platform.isMacOS,
			focused: this.isWindowFocused(),
			webPermission:
				typeof window !== "undefined" && window.Notification
					? window.Notification.permission
					: "n/a",
			electronRemoteNotification: remoteAvailable,
		});
	}

    onunload() {
        if (this.recorder.isRecording) {
            this.recorder.stop();
        }
        this.clearDurationTimer();
        this.clearActionStatus();
        if (this.retentionTimeout !== null) {
            window.clearTimeout(this.retentionTimeout);
            this.retentionTimeout = null;
        }
        if (this.dashboardRefreshTimer !== null) {
            window.clearTimeout(this.dashboardRefreshTimer);
            this.dashboardRefreshTimer = null;
        }
        this.dashboardBlocks.clear();
		this.statusHovered = false;
		this.hideQueuePopover();
		this.taskQueue.cancelAll();
		this.scheduler?.stop();
		this.agendaEvents.clear();
		for (const renderer of this.liveActionRenderers) renderer.unload();
		this.liveActionRenderers.clear();
		for (const controller of this.meetingNotices.values())
			controller.dispose();
		this.meetingNotices.clear();
		this.stopPromptNotice?.dispose();
		this.stopPromptNotice = null;
		// Settle any in-flight auto-transcribe waits so their listeners/timers
		// don't outlive the plugin.
		for (const ac of this.pendingAutoTranscribe.values()) ac.abort();
		this.pendingAutoTranscribe.clear();
    }

    async loadSettings() {
        const raw = (await this.loadData()) as
            | (Partial<SystemRecordingSettings> & {
                  enrichBaseUrl?: string;
                  enrichApiKey?: string;
                  /** Retired: canonical family used to live in sttModel + wire id in sttModelId. */
                  sttModelId?: string;
              })
            | null;
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            migrateSettings(raw as Record<string, unknown> | null)
        );
        // Normalize the shared endpoint (tolerate hand-edited data.json).
        this.settings.apiBaseUrl = (this.settings.apiBaseUrl ?? "").trim();
        this.settings.apiKey = (this.settings.apiKey ?? "").trim();
        // Clamp the transcription engine + local model to known values so a
        // hand-edited/corrupt data.json can't persist an unknown engine (which
        // would fall through to remote in the UI but stay wrong on disk) or a
        // stale model id.
        if (this.settings.transcriptionBackend !== "local") {
            this.settings.transcriptionBackend = "remote";
        }
        // Own-property check, not `in`: `in` walks the prototype chain, so a
        // hand-edited "constructor"/"toString"/etc. would slip past the clamp.
        if (
            !Object.prototype.hasOwnProperty.call(
                LOCAL_MODELS,
                this.settings.localWhisperModel
            )
        ) {
            this.settings.localWhisperModel = DEFAULT_SETTINGS.localWhisperModel;
        }
        // Migrate the previously enrichment-only endpoint into the shared fields
        // when the shared ones are still unset or at the default.
        const legacyBase = raw?.enrichBaseUrl?.trim();
        const legacyKey = raw?.enrichApiKey?.trim();
        if (
            legacyBase &&
            (!this.settings.apiBaseUrl ||
                this.settings.apiBaseUrl === DEFAULT_SETTINGS.apiBaseUrl)
        ) {
            this.settings.apiBaseUrl = legacyBase;
        }
        if (legacyKey && !this.settings.apiKey) {
            this.settings.apiKey = legacyKey;
        }
        // Clamp a value to a valid engine family, inferring one when the value
        // is a free-form wire id (e.g. a gateway deployment name).
        const clampApiType = (m: string): SttApiType =>
            (STT_MODELS as readonly string[]).includes(m)
                ? (m as SttApiType)
                : inferSttApiType(m);
        // Migrate the old split (sttModel = canonical family, sttModelId = wire id)
        // into the new model: sttModel is the wire id, sttApiType is the family.
        const legacyModelId = raw?.sttModelId?.trim();
        if (legacyModelId) {
            this.settings.sttApiType = clampApiType(
                String(raw?.sttModel ?? DEFAULT_SETTINGS.sttModel)
            );
            this.settings.sttModel = legacyModelId;
        } else if (raw?.sttApiType === undefined) {
            // Pre-apiType data: derive the family from the model name.
            this.settings.sttApiType = clampApiType(this.settings.sttModel);
        }
        // Don't persist the retired keys back into data.json.
        const bag = this.settings as unknown as Record<string, unknown>;
        delete bag.enrichBaseUrl;
        delete bag.enrichApiKey;
        delete bag.sttModelId;
        delete bag.vadMode;
        // Guard against corrupt/hand-edited data selecting an unknown engine
        // family, which would silently fall through to the GPT-4o path.
        this.settings.sttApiType = clampApiType(this.settings.sttApiType);
        // The UI no longer exposes a separate no-timestamps Whisper: collapse
        // the retired "whisper-1" family into the timestamp-intent one. Real
        // transcriptions downgrade back to plain whisper-1 on the wire when the
        // endpoint doesn't actually return timestamps (see resolveEngineFamily),
        // so nothing breaks for backends that reject verbose_json.
        if (this.settings.sttApiType === "whisper-1") {
            this.settings.sttApiType = "whisper-1-ts";
        }
        // Keep the OAuth refresh token and client secret out of the synced/
        // committed data.json: load them from per-vault localStorage instead,
        // migrating any legacy plaintext copies that still live in data.json.
        const localTokens = this.loadLocal<StoredTokens>("googleTokens");
        const localSecret = this.loadLocal<string>("googleClientSecret");
        const legacyTokens = raw?.googleTokens ?? null;
        const legacySecret =
            typeof raw?.googleClientSecret === "string"
                ? raw.googleClientSecret
                : "";
        this.settings.googleTokens = localTokens ?? legacyTokens;
        // localStorage is authoritative: use its value even when it's an empty
        // string (an intentionally cleared secret) and only fall back to the
        // legacy data.json copy when localStorage has nothing.
        this.settings.googleClientSecret =
            typeof localSecret === "string" ? localSecret : legacySecret;
        // If data.json still carries either secret (whether or not localStorage
        // already has a copy), re-persist so it gets moved into localStorage and
        // stripped from the synced file — don't leave a stale plaintext copy behind.
        const legacyInDataJson =
            legacyTokens !== null || legacySecret !== "";
        if (legacyInDataJson) {
            await this.saveSettings();
        }
    }

    async saveSettings() {
        // Sensitive fields live in per-vault localStorage, never in the synced/
        // committed data.json. Strip a field from data.json only once we've
        // *verified* it was durably written to localStorage — otherwise (older
        // Obsidian without the API, or a write failure) keep it in data.json so
        // we never silently lose the user's calendar credentials. Persist each
        // field independently so a failure on one doesn't skip the other.
        const tokensStored = this.saveLocal(
            "googleTokens",
            this.settings.googleTokens
        );
        const secretStored = this.saveLocal(
            "googleClientSecret",
            this.settings.googleClientSecret || null
        );
        const persisted: Record<string, unknown> = { ...this.settings };
        if (tokensStored) delete persisted.googleTokens;
        if (secretStored) delete persisted.googleClientSecret;
        await this.saveData(persisted);
    }

    /** Per-vault localStorage key for a sensitive credential field. */
    private secretKey(name: string): string {
        return `meeting-copilot/${name}`;
    }

    /** Obsidian's per-vault localStorage helpers (added in 1.8.7), if present. */
    private localStore(): {
        load(key: string): unknown;
        save(key: string, value: unknown): void;
    } | null {
        const app = this.app as unknown as {
            loadLocalStorage?(key: string): unknown;
            saveLocalStorage?(key: string, value: unknown): void;
        };
        if (
            typeof app.loadLocalStorage === "function" &&
            typeof app.saveLocalStorage === "function"
        ) {
            return {
                load: (k) => app.loadLocalStorage!(k),
                save: (k, v) => app.saveLocalStorage!(k, v),
            };
        }
        return null;
    }

    /** Reads a JSON value from per-vault localStorage (null if absent/unavailable/corrupt). */
    private loadLocal<T>(name: string): T | null {
        const store = this.localStore();
        if (!store) return null;
        const v = store.load(this.secretKey(name));
        if (typeof v !== "string") return null;
        try {
            return JSON.parse(v) as T;
        } catch {
            // Corrupt entry — treat as absent so we fall back to legacy/none.
            return null;
        }
    }

    /**
     * Writes (or clears, when null) a JSON value to per-vault localStorage and
     * verifies the round-trip. Returns false when the API is unavailable or the
     * value didn't persist, so the caller can keep the value in data.json.
     */
    private saveLocal(name: string, value: unknown): boolean {
        const store = this.localStore();
        if (!store) return false;
        const key = this.secretKey(name);
        try {
            store.save(key, value == null ? null : JSON.stringify(value));
            const back = store.load(key);
            if (value == null) return back == null;
            return back === JSON.stringify(value);
        } catch {
            return false;
        }
    }

    // MARK: - Recording control

    /**
     * Ribbon mic behavior. While recording it stops. Otherwise, if a meeting
     * note is the active file, it offers a choice — record another take for that
     * meeting, or start a fresh ad-hoc one — so the ribbon is useful when you're
     * looking at a meeting (e.g. the person finally joined and you want to
     * record again). With no meeting note in focus it just starts an ad-hoc
     * meeting, exactly as before.
     */
    private onRibbonClick(evt: MouseEvent): void {
        if (this.recorder.isRecording) {
            this.stopRecording();
            return;
        }
        const active = this.app.workspace.getActiveFile();
        if (active && this.isMeetingNote(active)) {
            const meeting = this.agendaMeetingFromNote(active);
            const menu = new Menu();
            menu.addItem((item) =>
                item
                    // Mirror the agenda row: "Record again" once a take exists.
                    .setTitle(
                        meeting.recording
                            ? t().event.recordAgain
                            : t().ribbon.recordForMeeting(meeting.title)
                    )
                    .setIcon("mic")
                    .onClick(() => this.startRecordingForMeeting(meeting))
            );
            menu.addItem((item) =>
                item
                    .setTitle(t().ribbon.newAdhoc)
                    .setIcon("plus")
                    .onClick(() => void this.startAdHocMeeting())
            );
            menu.showAtMouseEvent(evt);
            return;
        }
        void this.startAdHocMeeting();
    }

    /**
     * Starts an unplanned meeting: creates a meeting note (default title, ready
     * to rename), opens it with the title selected, and records beside it. On
     * stop the recording follows the same link → transcribe → enrich pipeline
     * as calendar meetings.
     */
    private async startAdHocMeeting(): Promise<void> {
        if (!Platform.isMacOS) {
            new Notice(t().notices.macOnly);
            return;
        }
        const now = new Date();
        const info: MeetingEventInfo = {
            // A stable non-empty id makes it a recognized meeting note right
            // away and avoids note-path collisions with other ad-hoc meetings.
            id: `${ADHOC_ID_PREFIX}${now.getTime()}`,
            summary: t().adhoc.defaultTitle,
            start: now,
            end: new Date(now.getTime() + 60 * 60 * 1000),
            meetLink: null,
            location: "",
            htmlLink: "",
            attendees: [],
            organizer: null,
            iCalUID: null,
            recurringEventId: null,
            oneOnOnePartner: null,
            oneOnOnePartnerEmail: null,
        };
        try {
            const ref = await createMeetingNote(this.app, info, this.noteConfig());
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(ref.file);
            this.selectNoteTitle(leaf);
            await this.startRecording(
                {
                    folder: ref.folder,
                    basename: ref.basename,
                    notePath: ref.notePath,
                    eventId: info.id,
                    note: ref.file,
                },
                { replaceCurrent: true }
            );
            new Notice(t().adhoc.started);
        } catch (e) {
            new Notice(
                t().notices.recordingError(
                    e instanceof Error ? e.message : String(e)
                )
            );
        }
    }

    /** Selects the H1 title in a freshly opened note so the user can rename it. */
    private selectNoteTitle(leaf: import("obsidian").WorkspaceLeaf): void {
        const view = leaf.view instanceof MarkdownView ? leaf.view : null;
        if (!view) return;
        const editor = view.editor;
        for (let i = 0; i < editor.lineCount(); i++) {
            const line = editor.getLine(i);
            if (line.startsWith("# ")) {
                editor.setSelection(
                    { line: i, ch: 2 },
                    { line: i, ch: line.length }
                );
                editor.focus();
                return;
            }
        }
    }

    private async startRecording(
        meeting: {
            folder: string;
            basename: string;
            notePath: string;
            eventId?: string;
            /** Calendar event end (epoch ms) for auto-stop; null/omitted for ad-hoc. */
            eventEnd?: number | null;
            note?: TFile;
        },
        opts?: { replaceCurrent?: boolean }
    ) {
        console.warn("[Meeting Copilot][recorder] startRecording requested", {
            notePath: meeting.notePath,
            eventId: meeting.eventId,
            isRecording: this.recorder.isRecording,
            starting: this.starting,
            replaceCurrent: opts?.replaceCurrent ?? false,
        });
        const replace = opts?.replaceCurrent ?? false;
        // Hold stop-prompt suppression for the whole handoff (stop → provision →
        // spawn) so a calendar/detector end can't kill the take we're starting.
        // Refcount: a second overlapping start that early-returns must not clear
        // suppression for an earlier handoff still in flight.
        if (replace) {
            this.dismissStopPrompt();
            this.replacingDepth++;
        }
        try {
            if (this.recorder.isRecording) {
                // Back-to-back meetings: stop the prior recording (and let it finish
                // linking/auto-transcribing) before starting this one, so B's first
                // minutes aren't lost to an "already recording" bail.
                if (replace) {
                    await this.stopAndWait();
                } else {
                    console.warn(
                        "[Meeting Copilot][recorder] startRecording skipped: already recording"
                    );
                    new Notice(t().notices.alreadyRecording);
                    return;
                }
            }

            // A start is already in progress (binary provisioning may be awaiting)
            if (this.starting) {
                console.warn(
                    "[Meeting Copilot][recorder] startRecording skipped: a start is already in progress"
                );
                return;
            }

            if (!Platform.isMacOS) {
                new Notice(t().notices.macOnly);
                return;
            }

            this.starting = true;
            try {
                // Ensure the recorder helper runtime is present and verified: the
                // binary AND the whisper.framework dylib it links at launch (dyld
                // rejects the binary without it, so this guards recording too — not
                // just transcription).
                let binaryPath: string;
                try {
                    binaryPath = await this.ensureHelperRuntime();
                } catch (e) {
                    new Notice(e instanceof Error ? e.message : String(e));
                    return;
                }

                const adapter = this.app.vault.adapter;
                // Sampled once so the path extension and the helper's --format
                // can't diverge if the settings toggle flips during the awaits
                // below.
                const format = this.recordingFormat();

                // Meeting recordings go under a "Recordings" subfolder of the note's
                // own folder (configurable; empty = colocate beside the note).
                // A note at the vault root has folder "" (nothing to create).
                // Ensure the note's folder before its (nested) Recordings child,
                // so the subfolder mkdir can't fail on a missing parent.
                if (meeting.folder && !(await adapter.exists(meeting.folder))) {
                    await adapter.mkdir(meeting.folder);
                }
                const recFolder = this.recordingFolderFor(meeting.folder);
                if (
                    recFolder &&
                    recFolder !== meeting.folder &&
                    !(await adapter.exists(recFolder))
                ) {
                    await adapter.mkdir(recFolder);
                }
                const relativePath = await this.uniqueRecordingPath(
                    adapter,
                    recFolder,
                    meeting.basename,
                    format
                );
                this.currentMeetingNotePath = meeting.notePath;
                this.currentMeetingNote = meeting.note ?? null;
                this.currentRecordingEventId = meeting.eventId ?? null;
                this.currentRecordingEventEnd = meeting.eventEnd ?? null;

                this.currentRecordingPath = relativePath;
                const vaultBasePath =
                    adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
                const absolutePath = path.join(vaultBasePath, relativePath);

                // Start recording. --split writes the per-speaker sidecars only when
                // separation is actually usable, so we don't pay for them otherwise.
                // Re-arm the screen-recording-settings opener for this attempt: a
                // permission failure surfaces asynchronously via onError, and each
                // new recording attempt is a deliberate user action that should get
                // one fresh chance to deep-link to System Settings.
                this.screenSettingsOpened = false;
                const inputDeviceUid = await this.resolveInputDeviceUid(binaryPath);
                this.recorder.start(binaryPath, absolutePath, {
                    split: this.shouldSeparateSpeakers(),
                    format,
                    inputDeviceUid,
                });
                this.recordingStartTime = Date.now();
                this.startDurationTimer();
                this.updateRibbonIcon(true);
                this.agendaEvents.emit("changed", undefined);
                // A recording is now underway — drop every pending join/record/stop
                // prompt so a stale action can't kill this take.
                this.dismissAllLivePrompts();

                new Notice(t().notices.recordingStarted);
            } finally {
                this.starting = false;
            }
        } finally {
            if (replace) this.replacingDepth = Math.max(0, this.replacingDepth - 1);
        }
    }

    private stopRecording() {
        if (!this.recorder.isRecording) {
            new Notice(t().notices.notRecording);
            return;
        }

        this.recorder.stop();
        new Notice(t().notices.stoppingRecording);
    }

    /**
     * Stops the current recording and resolves once it has fully wound down —
     * the recorder has terminated and its file has been linked/handled — so a
     * back-to-back recording can start against clean state. Resolves immediately
     * when nothing is recording.
     */
    private stopAndWait(): Promise<void> {
        // "Fully wound down" means both the recorder has terminated *and* the
        // just-stopped file has finished linking/handling — not merely
        // `isRecording === false` — so a chained start begins against clean
        // shared state. Wait when either is still true.
        if (!this.recorder.isRecording && !this.attaching) {
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            this.stopWaiters.push(resolve);
            if (this.recorder.isRecording) this.recorder.stop();
        });
    }

    /** Resolves any pending back-to-back waiters once a stop has fully settled. */
    private resolveStopWaiters(): void {
        const waiters = this.stopWaiters;
        this.stopWaiters = [];
        for (const resolve of waiters) resolve();
    }

	// MARK: - Calendar integration

	isCalendarAuthenticated(): boolean {
		return this.oauth.isAuthenticated();
	}

	async authenticateCalendar(): Promise<void> {
		try {
			await this.oauth.authenticate();
			this.authExpired = false;
			this.updateScheduler();
			this.agendaEvents.emit("changed", undefined);
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e));
		}
	}

	/**
	 * The refresh token is permanently dead (tokens already cleared by the OAuth
	 * layer). Stop polling and show a single actionable "reconnect" notice — the
	 * agenda flips to its Connect state on its own since we're no longer
	 * authenticated. The flag stops the scheduler's per-poll error notice from
	 * also firing for this cycle.
	 */
	private onCalendarAuthExpired(): void {
		if (this.authExpired) return;
		this.authExpired = true;
		this.scheduler?.stop();
		this.dismissMeetingNotices(SystemRecordingPlugin.CAL_NOTICE_PREFIX, {
			keepOs: true,
		});
		this.agendaEvents.emit("changed", undefined);
		actionNotice(
			t().notices.calendarReconnect,
			t().notices.calendarReconnectAction,
			() => void this.authenticateCalendar()
		);
	}

	/**
	 * Starts the scheduler when any calendar automation is on (notifications,
	 * auto-start, or auto-stop) and we're authenticated; stops it otherwise.
	 * Auto-start/stop drive the scheduler on their own — they aren't inert just
	 * because the notification prompts are turned off.
	 */
	updateScheduler(): void {
		const shouldRun =
			(this.settings.calendarAutoRecord ||
				this.settings.calendarAutoStart ||
				this.settings.calendarAutoStop) &&
			this.oauth.isAuthenticated();
		if (shouldRun) {
			if (!this.scheduler) {
				this.scheduler = new CalendarScheduler({
					now: () => Date.now(),
					fetchEvents: (minMs, maxMs) => this.fetchCalendarEvents(minMs, maxMs),
					leadMs: () =>
						Math.max(0, this.settings.notifyBeforeStartMinutes) *
						60 * 1000,
					onEventUpcoming: (event) => this.handleEventUpcoming(event),
					onEventStart: (event) => this.handleEventStart(event),
					onEventEnd: (event) => this.handleEventEnd(event),
					onError: (message) => {
						// A dead-token error is handled by onCalendarAuthExpired
						// (which shows a reconnect prompt); don't also loop the raw error.
						if (this.authExpired) return;
						new Notice(t().notices.calendarError(message));
					},
					registerInterval: (id) => this.registerInterval(id),
				});
			}
			if (!this.scheduler.isRunning) this.scheduler.start();
		} else {
			this.scheduler?.stop();
			// No more boundary callbacks will fire, so sweep any calendar prompts'
			// in-app notices rather than leaving them stale (detection prompts,
			// driven separately, are left alone). Keep the OS notifications in
			// Notification Center so a missed prompt stays recoverable there.
			this.dismissMeetingNotices(SystemRecordingPlugin.CAL_NOTICE_PREFIX, {
				keepOs: true,
			});
		}
	}

	/** Re-poll the calendar immediately (e.g. after changing the target calendar). No-op if not running. */
	refreshCalendarNow(): void {
		void this.scheduler?.poll();
	}

	// MARK: - Meeting detection (Tier 1, macOS)

	/** Starts/stops the meeting-detection poller based on settings (macOS only). */
	updateDetector(): void {
		if (this.detectorIntervalId !== null) {
			window.clearInterval(this.detectorIntervalId);
			this.detectorIntervalId = null;
		}
		const enabled = this.enabledProbeApps();
		// Don't poll if disabled, off-platform, or no probe is enabled (an empty
		// probe set would otherwise be read as "all meetings ended"). Drop the
		// detector so a later re-enable starts from a clean state (no stale
		// "active" app that would false-end an unrelated recording).
		if (
			!this.settings.detectMeetings ||
			enabled.size === 0 ||
			!Platform.isMacOS
		) {
			this.detector = null;
			// No probe will fire onEnd now, so sweep any detection prompts'
			// in-app notices (mirrors the calendar sweep when the scheduler stops),
			// keeping their OS notifications in Notification Center.
			this.dismissMeetingNotices("detect:", { keepOs: true });
			return;
		}
		if (!this.detector) {
			this.detector = new MeetingDetector({
				probe: () => this.probeMeetings(),
				onStart: (app) => this.onMeetingDetected(app),
				onEnd: (app) => this.onMeetingEnded(app),
				onError: (e) => console.error("Meeting detection probe failed", e),
			});
		} else {
			// A probe may have just been disabled — forget it silently (not an end).
			this.detector.retainOnly(enabled);
		}
		const seconds = Math.min(
			120,
			Math.max(3, this.settings.detectionIntervalSeconds)
		);
		void this.detector.poll();
		this.detectorIntervalId = window.setInterval(
			() => void this.detector?.poll(),
			seconds * 1000
		);
		this.registerInterval(this.detectorIntervalId);
	}

	/** The conferencing app names currently enabled for detection. */
	private enabledProbeApps(): Set<string> {
		const apps = new Set<string>();
		if (this.settings.detectZoom) apps.add("Zoom");
		if (this.settings.detectGoogleMeet) apps.add("Google Meet");
		return apps;
	}

	/** Collects the set of conferencing apps currently in a meeting. */
	private async probeMeetings(): Promise<Set<string>> {
		const active = new Set<string>();
		const checks: Promise<void>[] = [];
		if (this.settings.detectZoom) {
			checks.push(
				zoomInMeeting().then((on) => {
					if (on) active.add("Zoom");
				})
			);
		}
		if (this.settings.detectGoogleMeet) {
			checks.push(
				googleMeetActive().then((on) => {
					if (on) active.add("Google Meet");
				})
			);
		}
		await Promise.all(checks);
		return active;
	}

	/** Offers to record when a meeting is detected — unless we're already recording. */
	private onMeetingDetected(app: string): void {
		if (this.recorder.isRecording) return;
		// A calendar meeting happening right now already produced its own
		// (scheduler) notification — don't stack a second detection prompt for
		// what is almost certainly the same meeting. (No scheduler / no live
		// event ⇒ this is an unplanned meeting, so still prompt.)
		if (this.scheduler?.isRunning && this.scheduler.hasActiveEvent()) return;
		// A detected meeting has no calendar link to join, so only offer Record.
		this.promptMeeting({
			key: `detect:${app}`,
			title: t().detect.detected(app),
			subtitle: t().event.startingNow,
			meetLink: null,
			onRecord: () => void this.startAdHocMeeting(),
		});
	}

	/**
	 * When a detected meeting ends, never stop the recording on its own — offer
	 * to stop instead, for both ad-hoc and scheduled recordings. (Auto-stop only
	 * ever happens at a calendar event's own end when the user opted into it; see
	 * {@link handleEventEnd}.)
	 */
	private onMeetingEnded(app: string): void {
		// The detected meeting is over, so a pending "record?" prompt for it is
		// moot — drop its in-app notice whether or not we go on to offer a stop
		// below, but keep the OS notification recoverable in Notification Center.
		this.dismissMeetingNotice(`detect:${app}`, { keepOs: true });
		// Ignore if detection was disabled meanwhile (an in-flight poll's onEnd
		// must not prompt after the user opted out), and only act once *all*
		// detected meetings have ended so one of several concurrent calls ending
		// doesn't prompt while another is still live.
		if (!this.detector || this.detector.activeCount() > 0) return;
		if (!this.recorder.isRecording) return;
		this.promptStopRecording(t().detect.ended(app), t().event.stopRecordingPrompt);
	}

	/**
	 * Posts a meeting prompt on exactly one channel so surfaces never stack:
	 *
	 *  - **Focused** → in-app Notice only.
	 *  - **Unfocused** → native OS notification only; when Obsidian becomes
	 *    frontmost, {@link onPromptWindowFocused} closes the OS handle and shows
	 *    the in-app Notice.
	 *
	 * The returned controller's `dispose()` closes the OS notification by default
	 * (supersede / user action); housekeeping sweeps pass `{ keepOs: true }` to
	 * leave it in Notification Center so a missed prompt stays recoverable.
	 */
	private startOsPrompt(opts: {
		title: string;
		body: string;
		webHint: string;
		/** Native/web body click (Obsidian is already brought to the front). */
		onClick: () => void;
		/** Native action buttons (first = default). */
		actions: OsNotificationAction[];
		/** Builds the in-app notice (called when focused, or on focus-swap). */
		showInApp: () => InAppHandle;
	}): DualChannelController {
		const focused = this.isWindowFocused();
		notifLog("startOsPrompt", {
			title: opts.title,
			focused,
			actions: opts.actions.length,
		});
		const controller = startDualChannelPrompt({
			focused,
			showInApp: () => {
				notifLog("startOsPrompt: showInApp -> creating in-app notice", {
					title: opts.title,
				});
				return opts.showInApp();
			},
			showOs: (fallbackToInApp) => {
				notifLog("startOsPrompt: unfocused -> posting OS notification", {
					title: opts.title,
				});
				return notifyOs({
					title: opts.title,
					body: opts.body,
					webHint: opts.webHint,
					onClick: opts.onClick,
					actions: opts.actions,
					onShown: () => {
						notifLog("startOsPrompt: onShown (OS delivered)", {
							title: opts.title,
						});
						// A system notification reached the screen — a good moment
						// to teach (once) how to make them show/persist reliably.
						this.maybeShowNotificationStyleHint();
					},
					onFailed: () => {
						notifLog("startOsPrompt: onFailed (OS could not show)", {
							title: opts.title,
						});
						fallbackToInApp();
					},
				});
			},
		});
		// Electron's isFocused can disagree with document.hasFocus while the user
		// is already in Obsidian — recover the in-app Notice immediately so the
		// exclusive-channel path doesn't leave them with only an OS banner.
		if (
			!focused &&
			typeof document !== "undefined" &&
			document.visibilityState === "visible" &&
			document.hasFocus()
		) {
			controller.onBecameFocused();
		}
		return controller;
	}

	/**
	 * Obsidian became frontmost: swap every live OS-only prompt to its in-app
	 * Notice so the full action set is waiting in the window.
	 */
	private onPromptWindowFocused(): void {
		this.stopPromptNotice?.onBecameFocused();
		for (const controller of this.meetingNotices.values()) {
			controller.onBecameFocused();
		}
	}

	/**
	 * True when Obsidian's window is actually frontmost and visible — so an
	 * in-app notice would be seen. Prefers Electron's `BrowserWindow` state
	 * (reliable), falling back to the document's focus/visibility when `remote`
	 * isn't reachable. Logs the raw signals so a focus-detection regression is
	 * visible in traces.
	 */
	private isWindowFocused(): boolean {
		const doc = typeof document !== "undefined" ? document : null;
		const hasFocus = !!doc && doc.hasFocus();
		const visibilityState = doc ? doc.visibilityState : "n/a";
		let win: BrowserWindowState | null = null;
		try {
			const req = (window as unknown as { require?: (id: string) => unknown })
				.require;
			const electron =
				typeof req === "function"
					? (req("electron") as
							| {
									remote?: {
										getCurrentWindow?: () => {
											isFocused: () => boolean;
											isMinimized: () => boolean;
											isVisible: () => boolean;
										};
									};
							  }
							| undefined)
					: undefined;
			const current = electron?.remote?.getCurrentWindow?.();
			if (current) {
				win = {
					isFocused: current.isFocused(),
					isMinimized: current.isMinimized(),
					isVisible: current.isVisible(),
				};
			}
		} catch (err) {
			notifLog("isWindowFocused: remote threw", { err: String(err) });
		}
		const result = decideWindowFocused({ win, visibilityState, hasFocus });
		notifLog("isWindowFocused", {
			hasFocus,
			visibilityState,
			isFocused: win?.isFocused ?? null,
			isMinimized: win?.isMinimized ?? null,
			isVisible: win?.isVisible ?? null,
			result,
		});
		return result;
	}

	/**
	 * Opens macOS System Settings at the Notifications pane. macOS won't let an
	 * app change these for you, so this is the one-click path to the two settings
	 * meeting prompts need: the global "Allow notifications when mirroring or
	 * sharing the display" toggle (so they appear *while recording* instead of
	 * landing silently in Notification Center) and Obsidian's row set to "Alerts"
	 * (so they persist on screen with a button). Both live on this pane.
	 */
	openMacNotificationSettings(): void {
		if (!Platform.isMacOS) return;
		execFile(
			"open",
			["x-apple.systempreferences:com.apple.Notifications-Settings.extension"],
			(err) => {
				if (err)
					console.warn("Failed to open Notification settings", err);
			}
		);
	}

	/**
	 * One-time onboarding tip: the first time a meeting notification is shown,
	 * point the user at the macOS "Alerts" style so notifications stay on screen
	 * (with their buttons) instead of auto-dismissing. Never nags again.
	 */
	private maybeShowNotificationStyleHint(): void {
		if (!Platform.isMacOS || this.settings.notificationStyleHintShown) return;
		this.settings.notificationStyleHintShown = true;
		void this.saveSettings();
		multiActionNotice(t().notices.notificationStyleHint, [
			{
				label: t().notices.openNotificationSettings,
				onClick: () => this.openMacNotificationSettings(),
				cta: true,
			},
			{ label: t().event.dismiss, onClick: () => undefined },
		]);
	}

	/**
	 * Offers to stop the current recording (a recording never stops on its own)
	 * on a single channel: in-app Notice when focused, OS notification when not.
	 * Supersedes every live prompt so end-of-meeting triggers that overlap
	 * (detected-meeting end + calendar event end) don't stack.
	 */
	private promptStopRecording(title: string, body: string): void {
		// A back-to-back replace is stopping/starting on purpose — don't nag, and
		// don't leave a stop action that could kill the next take.
		if (this.replacingDepth > 0) {
			notifLog("promptStopRecording: suppressed (replace in flight)", {
				title,
			});
			return;
		}
		notifLog("promptStopRecording", { title, body });
		this.dismissAllLivePrompts();
		const stop = (): void => {
			// Tear down our own prompt first (hides the in-app notice and closes
			// the OS notification) so nothing stale survives the stop.
			this.dismissStopPrompt();
			this.stopRecording();
		};
		this.stopPromptNotice = this.startOsPrompt({
			title,
			body,
			webHint: t().event.notificationWebHint,
			// Body click focuses Obsidian (handled by notifyOs); the in-app Notice
			// appears via onBecameFocused with the Stop action.
			onClick: () => {},
			actions: [{ text: t().event.stopRecordingAction, run: stop }],
			showInApp: () =>
				actionNotice(`${title} — ${body}`, t().event.stopRecordingAction, stop),
		});
	}

	/**
	 * Prompts the user to act on an upcoming/starting meeting on a single channel
	 * (in-app Notice when focused, OS notification when not). No modal — the
	 * Notice / native action button carry Join, Record, Join & record, Open note.
	 *
	 * `onRecord` is the record action; a valid https `meetLink` adds the Join
	 * affordances, and an `onOpenNote` adds an "Open note" action (Granola-style).
	 */
	private promptMeeting(opts: {
		/** Stable per-meeting key (used for bookkeeping; a new prompt clears all). */
		key: string;
		title: string;
		subtitle: string;
		meetLink: string | null;
		onRecord: () => void;
		/** Opens (creating if needed) the meeting note without recording. Omitted for ad-hoc/detected meetings. */
		onOpenNote?: () => void;
		/** Called whenever the user opens the link (Join / Join & record), so the auto-open at start can be suppressed. */
		onLinkOpened?: () => void;
	}): void {
		notifLog("promptMeeting", {
			key: opts.key,
			title: opts.title,
			hasLink: !!opts.meetLink,
		});
		const link =
			opts.meetLink && opts.meetLink.startsWith("https://")
				? opts.meetLink
				: null;
		// Every channel shares these handlers, and each first dismisses the live
		// prompt for this meeting so acting from the OS notification doesn't leave
		// a parallel in-app Notice after a focus-swap.
		const dismissNotice = (): void => this.dismissMeetingNotice(opts.key);
		const onRecord = (): void => {
			dismissNotice();
			opts.onRecord();
		};
		const onOpenNote = opts.onOpenNote
			? (): void => {
					dismissNotice();
					opts.onOpenNote?.();
				}
			: null;
		const onJoin = link
			? (): void => {
					dismissNotice();
					opts.onLinkOpened?.();
					this.openMeetingLink(link);
				}
			: null;
		const onJoinAndRecord = link
			? (): void => {
					dismissNotice();
					opts.onLinkOpened?.();
					this.openMeetingLink(link);
					opts.onRecord();
				}
			: null;

		// Action order mirrors Granola: a combined primary (Join & record) when
		// there's a link — else Record — then Join, then Open note. Only the first
		// becomes the OS notification's button; the full set stays in the in-app
		// notice. When already recording, primary labels warn that the current
		// take will stop.
		const e = t().event;
		const stopsCurrent = this.recorder.isRecording;
		const actions: NoticeAction[] = [];
		if (onJoinAndRecord) {
			actions.push({
				label: stopsCurrent ? e.joinAndRecordStopsCurrent : e.joinAndRecord,
				onClick: onJoinAndRecord,
				cta: true,
			});
			if (onJoin) actions.push({ label: e.join, onClick: onJoin });
		} else {
			actions.push({
				label: stopsCurrent ? e.recordStopsCurrent : e.record,
				onClick: onRecord,
				cta: true,
			});
		}
		if (onOpenNote)
			actions.push({ label: e.openNote, onClick: onOpenNote });

		// One prompt surface at a time — drop every live meeting/stop prompt
		// before posting this one.
		this.dismissAllLivePrompts();
		this.meetingNotices.set(
			opts.key,
			this.startOsPrompt({
				title: opts.title,
				body: opts.subtitle,
				webHint: e.notificationWebHint,
				// Body click focuses Obsidian; the in-app Notice (full actions)
				// appears via onBecameFocused. No modal.
				onClick: () => {},
				// macOS/Electron renders a *single* action as a named inline
				// button but collapses two-or-more into a generic "Options ▾"
				// dropdown. Users want the named default button, so the OS
				// notification carries only the primary action; the rest stay one
				// tap away via the in-app notice after focus.
				actions: actions
					.slice(0, 1)
					.map((a) => ({ text: a.label, run: a.onClick })),
				showInApp: () =>
					multiActionNotice(
						`${opts.title} — ${opts.subtitle}`,
						actions,
						// Once the user picks an action the notice is gone — drop
						// our bookkeeping entry so the map only ever holds live
						// prompts.
						() => this.meetingNotices.delete(opts.key)
					),
			})
		);
	}

	/** Prefix for calendar-event prompt keys (vs. `detect:` for detected meetings). */
	private static readonly CAL_NOTICE_PREFIX = "cal:";

	/** Drops the live stop-recording prompt, if any. */
	private dismissStopPrompt(): void {
		this.stopPromptNotice?.dispose();
		this.stopPromptNotice = null;
	}

	/**
	 * Drops every live meeting + stop prompt (closes OS unless a caller already
	 * disposed with keepOs). Used when starting a recording or posting a new
	 * exclusive prompt so stale actions can't fire.
	 */
	private dismissAllLivePrompts(): void {
		for (const controller of this.meetingNotices.values()) {
			controller.dispose();
		}
		this.meetingNotices.clear();
		this.dismissStopPrompt();
	}

	/**
	 * Dismisses the persistent meeting prompt for one key (if any). Used once a
	 * decision has been made for the meeting (auto-start fired, we're already
	 * recording it, or it just ended) so a now-stale prompt doesn't linger or
	 * stack under a new one.
	 *
	 * Housekeeping callers (a meeting that just ended, not a user action) pass
	 * `{ keepOs: true }` so the OS notification stays in Notification Center and a
	 * missed prompt remains recoverable there.
	 */
	private dismissMeetingNotice(
		key: string,
		opts?: { keepOs?: boolean }
	): void {
		this.meetingNotices.get(key)?.dispose(opts);
		this.meetingNotices.delete(key);
	}

	/**
	 * Dismisses every live prompt whose key starts with `prefix`. Housekeeping
	 * sweeps (scheduler/detector turned off, auth expired) pass `{ keepOs: true }`
	 * so the OS notifications survive in Notification Center.
	 */
	private dismissMeetingNotices(
		prefix: string,
		opts?: { keepOs?: boolean }
	): void {
		for (const [key, controller] of this.meetingNotices) {
			if (!key.startsWith(prefix)) continue;
			controller.dispose(opts);
			this.meetingNotices.delete(key);
		}
	}

	private async fetchCalendarEvents(
		minMs: number,
		maxMs: number
	): Promise<ScheduledEvent[]> {
		const events = await listEvents(
			this.oauth,
			this.settings.calendarId,
			new Date(minMs),
			new Date(maxMs),
			250,
			parseKeywords(this.settings.exclusionKeywords)
		);
		return events.map((e) => ({
			id: e.id,
			summary: e.summary,
			start: e.start.getTime(),
			end: e.end.getTime(),
			meetLink: e.meetLink,
			location: e.location,
			htmlLink: e.htmlLink,
			attendees: e.attendees,
			organizer: e.organizer,
			iCalUID: e.iCalUID,
			recurringEventId: e.recurringEventId,
			oneOnOnePartner: e.oneOnOnePartner,
			oneOnOnePartnerEmail: e.oneOnOnePartnerEmail,
		}));
	}

	/**
	 * Fired `notifyBeforeStartMinutes` before an event begins: warn the user the
	 * meeting is about to start, with Join / Record options. When auto-start is
	 * on the recording will begin on its own at the boundary, so the lead-time
	 * prompt is mainly a heads-up (Record still lets them start early).
	 */
	private handleEventUpcoming(event: ScheduledEvent): void {
		// The scheduler may be running purely for auto-start/stop; the lead-time
		// heads-up is a notification, so only show it when notifications are on.
		if (!this.settings.calendarAutoRecord) return;
		const minutesUntil = Math.max(
			1,
			Math.round((event.start - Date.now()) / 60000)
		);
		this.promptCalendarMeeting(event, t().event.startsInMin(minutesUntil));
	}

	private handleEventStart(event: ScheduledEvent): void {
		this.maybeOpenMeetLink(event);

		// Auto-start: begin recording without asking (back-to-back chaining stops
		// any prior recording first). Skip if we're already recording this event
		// (e.g. the user hit Record on the lead-time prompt).
		if (this.settings.calendarAutoStart) {
			// The lead-time heads-up is now moot — recording is (or is about to
			// be) underway — so clear it rather than leaving it on screen.
			this.dismissMeetingNotice(SystemRecordingPlugin.CAL_NOTICE_PREFIX + event.id);
			if (this.currentRecordingEventId !== event.id) {
				new Notice(t().event.autoStarted(event.summary));
				void this.startMeetingRecording(this.toMeetingInfo(event), event.end);
			}
			return;
		}

		// Otherwise prompt — unless the user already started recording this event
		// from the lead-time prompt (its Record button), in which case there's
		// nothing to ask.
		if (this.currentRecordingEventId === event.id) {
			this.dismissMeetingNotice(SystemRecordingPlugin.CAL_NOTICE_PREFIX + event.id);
			return;
		}
		// Auto-start is off and notifications are off (scheduler is running only
		// for auto-stop): don't surface a start prompt the user didn't ask for.
		if (!this.settings.calendarAutoRecord) return;
		const lateMs = Date.now() - event.start;
		const subtitle =
			lateMs > GRACE_MS
				? t().event.startedMinAgo(Math.max(1, Math.round(lateMs / 60000)))
				: t().event.startingNow;
		this.promptCalendarMeeting(event, subtitle);
	}

	/** Opens the event's meeting link once, if configured and it's a safe https URL. */
	private maybeOpenMeetLink(event: ScheduledEvent): void {
		if (
			!this.settings.openMeetAutomatically ||
			!event.meetLink ||
			!event.meetLink.startsWith("https://") ||
			this.openedLinkEventIds.has(event.id)
		) {
			return;
		}
		// Guard against double-opening across the upcoming/start boundaries.
		this.openedLinkEventIds.add(event.id);
		window.open(event.meetLink, "_blank");
	}

	/** Shared calendar meeting prompt (upcoming + start). */
	private promptCalendarMeeting(event: ScheduledEvent, subtitle: string): void {
		this.promptMeeting({
			key: SystemRecordingPlugin.CAL_NOTICE_PREFIX + event.id,
			title: event.summary,
			subtitle,
			meetLink: event.meetLink,
			onRecord: () =>
				void this.startMeetingRecording(this.toMeetingInfo(event), event.end),
			// Open (or create) the meeting note without recording — the "Open
			// note" affordance, mirroring the agenda card.
			onOpenNote: () => void this.openOrCreateEventNote(this.toMeetingInfo(event)),
			// A manual Join opens the link, so don't let the auto-open fire again
			// when the start boundary is crossed.
			onLinkOpened: () => this.openedLinkEventIds.add(event.id),
		});
	}

	/**
	 * Opens the meeting note for an event, creating it first if none exists yet.
	 * Unlike the record path this never starts a recording — it's the prompt's
	 * "Open note" action (and reuses an already-created note so a later Record
	 * links into the same note rather than duplicating it).
	 */
	private async openOrCreateEventNote(info: MeetingEventInfo): Promise<void> {
		try {
			const existing = buildNoteIndex(this.app).get(info.id)?.file ?? null;
			const file =
				existing ??
				(await createMeetingNote(this.app, info, this.noteConfig())).file;
			await this.app.workspace.getLeaf(false).openFile(file);
			this.agendaEvents.emit("changed", undefined);
		} catch (e) {
			new Notice(
				t().notices.recordingError(
					e instanceof Error ? e.message : String(e)
				)
			);
		}
	}

	/**
	 * Creates & opens the meeting note from calendar data, then records beside
	 * it. `eventEndMs` is the event's end time, tracked so the recording can be
	 * auto-stopped at the boundary (and recovered after sleep). Passing
	 * `replaceCurrent` lets a back-to-back meeting stop the prior recording
	 * first instead of bailing with "already recording".
	 */
	private async startMeetingRecording(
		info: MeetingEventInfo,
		eventEndMs?: number
	): Promise<void> {
		if (!Platform.isMacOS) {
			new Notice(t().notices.macOnly);
			return;
		}
		// Fall back to the meeting's own end so the sleep/wake auto-stop safety net
		// covers every meeting recording (e.g. agenda "Create and record"), not
		// just the calendar-scheduler paths that pass an explicit end.
		const endMs = eventEndMs ?? info.end.getTime();
		try {
			const ref = await createMeetingNote(this.app, info, this.noteConfig());
			await this.app.workspace.getLeaf(false).openFile(ref.file);
			await this.startRecording(
				{
					folder: ref.folder,
					basename: ref.basename,
					notePath: ref.notePath,
					eventId: info.id,
					eventEnd: Number.isFinite(endMs) ? endMs : null,
					// Track the live TFile so a rename mid-recording still links the
					// WAV correctly (matches the ad-hoc path).
					note: ref.file,
				},
				{ replaceCurrent: true }
			);
		} catch (e) {
			new Notice(t().notices.recordingError(e instanceof Error ? e.message : String(e)));
		}
	}

	/**
	 * Starts a recording for a meeting. When the note already exists (agenda row,
	 * note context menu, or the ribbon on an open meeting note) it records
	 * straight into that file, bypassing the identity lookup — otherwise a note
	 * without an `event_id` (e.g. a hand-made `meeting_url`-only note) would be
	 * duplicated at the template-resolved path. Only when there is no note yet
	 * (a calendar meeting never opened) does it create one.
	 */
	private startRecordingForMeeting(m: AgendaMeeting): void {
		if (m.note) {
			void this.recordIntoNote(
				m.note,
				m.id || undefined,
				m.end instanceof Date ? m.end.getTime() : undefined
			);
		} else {
			void this.startMeetingRecording(agendaToMeetingInfo(m));
		}
	}

	/**
	 * True when meeting `m` is the one currently recording. Matches on the
	 * calendar event id, and falls back to the note path so record-again into a
	 * note without an `event_id` (e.g. a hand-made `meeting_url`-only note, whose
	 * `m.id` is "") still shows "Stop" on its row instead of "Record again".
	 */
	private isRecordingMeeting(m: AgendaMeeting): boolean {
		if (!this.recorder.isRecording) return false;
		if (this.currentRecordingEventId && this.currentRecordingEventId === m.id) {
			return true;
		}
		// Prefer the live note TFile's path over the string captured at record
		// start, so a rename mid-recording (which updates the TFile in place)
		// still matches the row.
		const recordingNotePath =
			this.currentMeetingNote?.path ?? this.currentMeetingNotePath;
		return m.note != null && recordingNotePath === m.note.path;
	}

	/** Records a new take directly into an existing note (no createMeetingNote). */
	private async recordIntoNote(
		file: TFile,
		eventId?: string,
		endMs?: number
	): Promise<void> {
		if (!Platform.isMacOS) {
			new Notice(t().notices.macOnly);
			return;
		}
		try {
			await this.app.workspace.getLeaf(false).openFile(file);
			await this.startRecording(
				{
					folder: folderOf(file),
					basename: file.basename,
					notePath: file.path,
					eventId,
					eventEnd:
						typeof endMs === "number" && Number.isFinite(endMs)
							? endMs
							: null,
					note: file,
				},
				{ replaceCurrent: true }
			);
		} catch (e) {
			new Notice(
				t().notices.recordingError(
					e instanceof Error ? e.message : String(e)
				)
			);
		}
	}

	private noteConfig(): MeetingNoteConfig {
		return {
			oneOffFolderTemplate: this.settings.oneOffFolderTemplate,
			seriesFolderTemplate: this.settings.seriesFolderTemplate,
			oneOnOneSeparately: this.settings.oneOnOneSeparately,
			oneOnOneFolder: this.settings.oneOnOneFolder,
			adhocFolder: this.settings.adhocFolder,
			titlePattern: effectiveTitlePattern(
				this.settings.noteTitlePatternCustomize,
				this.settings.noteTitlePattern
			),
			template: effectiveNoteTemplate(
				this.settings.noteTemplateCustomize,
				this.settings.noteTemplate
			),
		};
	}

	/**
	 * Distinct non-empty folders the plugin is configured to write meeting
	 * notes under: the static (token-free) prefix of each folder template,
	 * plus the ad-hoc and 1:1 folders. Used to scope "Needs attention" to
	 * plugin-owned territory, and as a retention fallback for a recording
	 * whose note was deleted.
	 */
	private configuredMeetingRoots(): string[] {
		// The empty-returning normalizer, deliberately: a folder setting that
		// normalizes to nothing must not claim the "Meetings" fallback as
		// plugin territory for the attention scan or the retention sweep.
		const roots = [
			templateStaticRoot(this.settings.oneOffFolderTemplate),
			templateStaticRoot(this.settings.seriesFolderTemplate),
			normalizeFolderPathOrEmpty(this.settings.adhocFolder),
			// Only claimed while the 1:1 feature is on: with it off the
			// plugin never writes there, and a user's own folder of the same
			// name must not become attention/retention territory.
			...(this.settings.oneOnOneSeparately
				? [normalizeFolderPathOrEmpty(this.settings.oneOnOneFolder)]
				: []),
		].filter((r) => r.length > 0);
		return [...new Set(roots)];
	}

	private toMeetingInfo(e: ScheduledEvent): MeetingEventInfo {
		return {
			...e,
			start: new Date(e.start),
			end: new Date(e.end),
		};
	}

	private handleEventEnd(event: ScheduledEvent): void {
		// The meeting is over: forget its auto-open state so a later recurrence
		// (same id, re-added by a poll) can open its link afresh, and drop the
		// lingering upcoming/start prompt's in-app notice (whether or not we
		// recorded), keeping its OS notification recoverable in Notification
		// Center.
		this.openedLinkEventIds.delete(event.id);
		this.dismissMeetingNotice(SystemRecordingPlugin.CAL_NOTICE_PREFIX + event.id, {
			keepOs: true,
		});

		// Decide what to do with an active recording at the scheduled end. Only
		// acts on *this* meeting's recording (so overlapping meetings can't stop
		// the wrong one). Auto-stop is honored as before; otherwise the "stop?"
		// suggestion is deferred while a conferencing app is still in a meeting
		// (the event ran over) — the detector will offer to stop when the real
		// meeting ends. `detectedOngoing` is null when detection can't answer,
		// which falls back to prompting at the boundary as before.
		const action = eventEndStopAction({
			isRecording: this.recorder.isRecording,
			isThisEventsRecording: this.currentRecordingEventId === event.id,
			autoStop: this.settings.calendarAutoStop,
			detectedOngoing: this.detector
				? this.detector.activeCount()
				: null,
		});
		switch (action) {
			case "auto-stop":
				new Notice(t().event.autoStopped(event.summary));
				this.stopRecording();
				break;
			case "prompt-stop":
				this.promptStopRecording(
					t().event.ended(event.summary),
					t().event.stopRecordingPrompt
				);
				break;
			case "defer":
			case "none":
				break;
		}
	}

    // MARK: - Meeting agenda

    /** Opens (or reveals) the agenda view in the right sidebar. */
    async openAgenda(): Promise<void> {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_AGENDA)[0] ?? null;
        if (!leaf) {
            leaf = workspace.getRightLeaf(false);
            await leaf?.setViewState({ type: VIEW_TYPE_AGENDA, active: true });
        }
        if (leaf) void workspace.revealLeaf(leaf);
    }

    /** Tells any open agenda view to reload (e.g. after a settings change). */
    refreshAgenda(): void {
        this.agendaEvents.emit("changed", undefined);
    }

    private agendaHost(): AgendaViewHost {
        return {
            getLookAhead: () => this.settings.agendaLookAheadDays,
            getLookBack: () => this.settings.agendaLookBackDays,
            setLookAhead: (n) => {
                this.settings.agendaLookAheadDays = n;
                void this.saveSettings();
            },
            isAuthenticated: () => this.isCalendarAuthenticated(),
            authenticate: () => this.authenticateCalendar(),
            fetchMeetings: (fromMs, toMs) => this.fetchAgendaMeetings(fromMs, toMs),
            isRecordingThis: (m) => this.isRecordingMeeting(m),
            onOpenOrCreate: (m) => void this.openOrCreateNote(m),
            onCreateAndRecord: (m) => this.startRecordingForMeeting(m),
            onCreateNote: (m) => void this.createNoteOnly(m),
            onStop: () => this.stopRecording(),
            onOpenRecording: (m) => void this.openRecording(m),
            onTranscribe: (m, mode) => void this.transcribeRecording(m, mode),
            onEnrich: (m) => {
                if (m.note) void this.enqueueEnrich(m.note);
            },
            onOpenLink: (url) => this.openMeetingLink(url),
            onCopyLink: (url) => void this.copyMeetingLink(url),
            openSettings: () => this.openPluginSettings(),
            events: this.agendaEvents,
        };
    }

    /** True when a note carries meeting frontmatter we can act on. */
    private isMeetingNote(file: TFile): boolean {
        if (file.extension !== "md") return false;
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
            | Record<string, unknown>
            | undefined;
        if (!fm) return false;
        const nonEmpty = (k: string): boolean => {
            const v = fm[k];
            return typeof v === "string" && v.trim().length > 0;
        };
        // `recording` may be a single link (legacy) or a YAML list (multiple
        // takes), so resolve through the list-aware helper rather than a bare
        // string check — otherwise a multi-take note wouldn't be recognized.
        const hasRecording = recordingLinkTarget(fm["recording"]) !== "";
        return (
            nonEmpty("event_id") || hasRecording || nonEmpty("meeting_url")
        );
    }

    /** Adds a "Meeting Copilot" submenu with the shared meeting actions. */
    private addNoteMeetingMenu(menu: Menu, file: TFile): void {
        menu.addItem((item) => {
            item.setTitle(t().agenda.menuTitle).setIcon("mic");
            const sub = item.setSubmenu();
            populateMeetingMenu(
                sub,
                this.agendaMeetingFromNote(file),
                this.noteRowHandlers(),
                { includeNavigation: false }
            );
        });
    }

    /**
     * Renders the dashboard's "Needs attention" table: meeting notes that
     * haven't finished the scheduled → recorded → transcribed → enriched
     * pipeline, each with buttons to open, transcribe, and enrich.
     */
    private renderAttention(el: HTMLElement): void {
        const restoreScroll = this.preserveScroll(el);
        el.empty();
        const d = t().dashboard.attention;
        const acts = t().agenda.actions;

        const roots = this.configuredMeetingRoots();
        const byPath = new Map<string, TFile>();
        const inputs: AttentionInput[] = [];
        // Meeting notes can live in any of several folders now (per-series,
        // per-1:1, ad-hoc, or wherever the user moved them). A note carrying
        // our own `event_id` is unambiguously plugin-owned and always shown;
        // otherwise (a foreign note that merely has `meeting_url`/`recording`
        // frontmatter) only surface it when it also lives under one of the
        // folders we're configured to write to — surfacing Transcribe/Enrich
        // buttons for a note the plugin doesn't own would rewrite it.
        for (const entry of scanMeetingNotes(this.app)) {
            const recLink = recordingLinkTarget(entry.recording);
            const hasRecording = recLink !== "";
            const pluginOwned = entry.eventId !== null;
            const legacyMatch =
                (hasRecording || entry.hasMeetingUrl) &&
                roots.some((root) => underFolder(entry.file.path, root));
            if (!pluginOwned && !legacyMatch) continue;

            const fm = this.app.metadataCache.getFileCache(entry.file)?.frontmatter as
                | Record<string, unknown>
                | undefined;
            const titleRaw = fm?.["title"];
            const title =
                typeof titleRaw === "string" && titleRaw
                    ? titleRaw
                    : entry.file.basename;

            // "Processing" = the plugin is already advancing this note on its
            // own — the recording is transcribing/queued, or it's being
            // enriched — so there's nothing for the user to do; skip it below.
            const recDest = hasRecording
                ? this.app.metadataCache.getFirstLinkpathDest(
                      recLink,
                      entry.file.path
                  )
                : null;
            const processing =
                this.taskQueue.has(this.enrichTaskId(entry.file.path)) ||
                (recDest instanceof TFile &&
                    this.taskQueue.has(recDest.path));

            byPath.set(entry.file.path, entry.file);
            inputs.push({
                path: entry.file.path,
                title,
                start: entry.stamp ? parseStampDate(entry.stamp) : null,
                status: entry.status,
                hasRecording,
                processing,
            });
        }

        const rows = computeAttention(inputs);

        const header = el.createDiv({ cls: "mc-attention-header" });
        header.createSpan({ text: d.count(rows.length) });
        const refresh = header.createEl("button", { text: d.refresh });
        refresh.onclick = () => this.renderAttention(el);

        if (rows.length === 0) {
            el.createEl("p", { text: d.allClear, cls: "mc-attention-empty" });
            restoreScroll();
            return;
        }

        const table = el.createEl("table", { cls: "mc-attention" });
        const head = table.createEl("thead").createEl("tr");
        for (const h of [
            d.colMeeting,
            d.colDate,
            d.colStatus,
            d.colMissing,
            d.colActions,
        ]) {
            head.createEl("th", { text: h });
        }
        const body = table.createEl("tbody");
        const pad = (n: number): string => String(n).padStart(2, "0");
        const fmtDate = (dt: Date): string =>
            `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(
                dt.getDate()
            )} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;

        for (const row of rows) {
            const file = byPath.get(row.path);
            const tr = body.createEl("tr");

            const nameTd = tr.createEl("td");
            const link = nameTd.createEl("a", {
                text: row.title,
                cls: "internal-link",
            });
            link.onclick = (e): void => {
                e.preventDefault();
                if (file) this.openFileInTab(file);
            };

            tr.createEl("td", { text: row.start ? fmtDate(row.start) : "—" });
            tr.createEl("td", { text: row.status });

            const missTd = tr.createEl("td");
            for (const m of row.missing) {
                missTd.createSpan({
                    text: d.missing[m],
                    cls: `mc-badge mc-badge-${m}`,
                });
            }

            const actTd = tr.createEl("td", { cls: "mc-attention-actions" });
            if (!file) continue;
            const meeting = this.agendaMeetingFromNote(file);
            const openBtn = actTd.createEl("button", { text: acts.openNote });
            openBtn.onclick = (): void => this.openFileInTab(file);
            if (meeting.recording) {
                const trBtn = actTd.createEl("button", {
                    text: acts.transcribe,
                });
                trBtn.onclick = (): void => void this.transcribeRecording(
                    meeting
                );
            }
            const enBtn = actTd.createEl("button", { text: acts.enrich });
            enBtn.onclick = (): void => void this.enqueueEnrich(file);
        }

        restoreScroll();
    }

    /**
     * Fetches the calendar events for the dashboard's Upcoming/Past tables,
     * over the *same* window the agenda sidebar uses (look-back/look-ahead
     * days), and caches the raw events briefly so the two blocks — and repeated
     * re-renders from paging/refresh — share a single request. Note/recording
     * state is intentionally *not* cached: each render re-derives it from the
     * vault, so creating a note updates both tables without a refetch. Returns
     * `[]` (no throw) when the calendar isn't connected, so the tables still
     * show vault notes. `force` bypasses the TTL (the Refresh button).
     */
    private dashboardEventsCache: { at: number; events: GCalEvent[] } | null =
        null;
    private dashboardEventsInFlight: Promise<GCalEvent[]> | null = null;
    private async loadDashboardEvents(force = false): Promise<GCalEvent[]> {
        if (!this.isCalendarAuthenticated()) return [];
        const TTL_MS = 60_000;
        const now = Date.now();
        if (
            !force &&
            this.dashboardEventsCache &&
            now - this.dashboardEventsCache.at < TTL_MS
        ) {
            return this.dashboardEventsCache.events;
        }
        if (!force && this.dashboardEventsInFlight) {
            return this.dashboardEventsInFlight;
        }
        const dayMs = 24 * 60 * 60 * 1000;
        const lookAhead = Math.max(1, this.settings.agendaLookAheadDays);
        const lookBack = Math.max(
            0,
            Math.min(30, this.settings.agendaLookBackDays)
        );
        const startOfToday = new Date();
        startOfToday.setHours(0, 0, 0, 0);
        const from = new Date(startOfToday.getTime() - lookBack * dayMs);
        const to = new Date(startOfToday.getTime() + lookAhead * dayMs);
        const p = listEvents(
            this.oauth,
            this.settings.calendarId,
            from,
            to,
            250,
            parseKeywords(this.settings.exclusionKeywords)
        )
            .then((events) => {
                this.dashboardEventsCache = { at: Date.now(), events };
                return events;
            })
            .finally(() => {
                this.dashboardEventsInFlight = null;
            });
        this.dashboardEventsInFlight = p;
        return p;
    }

    /**
     * Renders one of the dashboard's paginated meeting tables. It merges the
     * vault's meeting notes with the calendar events the agenda already loads
     * ({@link loadDashboardEvents}), so a scheduled meeting shows up before its
     * note exists: those rows aren't links and carry a "create note" action,
     * while noted rows link to the note. `direction` picks the bucket (upcoming
     * = `start >= now`, soonest first; past = newest first) and its persisted
     * per-page size (10/20/50/100). `page` is 1-based; the controls re-render
     * this same element. `force` re-fetches the calendar (the Refresh button).
     */
    private async renderMeetingsSection(
        el: HTMLElement,
        direction: MeetingDirection,
        page = 1,
        force = false
    ): Promise<void> {
        const d = t().dashboard.meetings;
        const seq = this.nextRenderSeq(el);
        const restoreScroll = this.preserveScroll(el);
        // Only clear up front on the very first paint (nothing to preserve).
        // On a refresh/page change we keep the old rows visible while the
        // calendar loads, then swap in one pass below — otherwise the section
        // briefly collapses to empty and the view jumps.
        if (el.childElementCount === 0 && this.isCalendarAuthenticated()) {
            el.createEl("p", { text: d.loading, cls: "mc-meetings-loading" });
        }

        let events: GCalEvent[] = [];
        let calendarError = false;
        try {
            events = await this.loadDashboardEvents(force);
        } catch {
            calendarError = true;
        }
        // A newer render started while the calendar loaded — let it win.
        if (this.renderSeq.get(el) !== seq) return;

        // Vault notes: any meeting note we own (`event_id`) or a legacy
        // `meeting_url` note the dashboard has always listed.
        const notesByPath = new Map<string, TFile>();
        const meetingsByKey = new Map<string, AgendaMeeting>();
        const inputs: DashboardMeetingInput[] = [];
        // Collapse notes sharing a key (event id, or path for legacy url-only
        // notes) to the most recently modified one, so a duplicated `event_id`
        // (e.g. a sync-conflict copy) shows the meeting once, not twice.
        const notedByKey = new Map<
            string,
            { input: DashboardMeetingInput; file: TFile; mtime: number }
        >();
        // Normalized meeting URLs of noted meetings, so a calendar event a
        // legacy `meeting_url` note already covers (but which carries no
        // matching `event_id`) isn't listed a second time below.
        const notedUrls = new Set<string>();
        const normalizeUrl = (v: unknown): string =>
            typeof v === "string"
                ? v.trim().replace(/\/+$/, "").toLowerCase()
                : "";
        // One vault scan feeds both the noted-meeting inputs below and the
        // note index used to dedup calendar events (reused, not re-walked).
        const scanned = scanMeetingNotes(this.app);
        for (const entry of scanned) {
            if (entry.eventId === null && !entry.hasMeetingUrl) continue;
            const fm = this.app.metadataCache.getFileCache(entry.file)
                ?.frontmatter as Record<string, unknown> | undefined;
            const titleRaw = fm?.["title"];
            const title =
                typeof titleRaw === "string" && titleRaw
                    ? titleRaw
                    : entry.file.basename;
            const url = normalizeUrl(fm?.["meeting_url"]);
            if (url) notedUrls.add(url);
            const key = entry.eventId ?? entry.file.path;
            const mtime = entry.file.stat?.mtime ?? 0;
            const existing = notedByKey.get(key);
            if (existing && existing.mtime >= mtime) continue;
            notedByKey.set(key, {
                input: {
                    key,
                    title,
                    start: entry.stamp ? parseStampDate(entry.stamp) : null,
                    status: entry.status ?? "",
                    hasRecording: recordingLinkTarget(entry.recording) !== "",
                    notePath: entry.file.path,
                },
                file: entry.file,
                mtime,
            });
        }
        for (const { input, file } of notedByKey.values()) {
            notesByPath.set(file.path, file);
            inputs.push(input);
        }

        // Calendar events without a note yet — the enrichment. A timed event
        // whose note already exists is dropped here (the note row above
        // represents it, with fresh state), whether the match is by `event_id`
        // or a legacy note's meeting URL. All-day entries (OOO, birthdays)
        // aren't meetings, so they're skipped.
        const index = buildNoteIndex(this.app, scanned);
        for (const ev of events) {
            if (ev.allDay) continue;
            const m = toAgendaMeeting(ev, index);
            if (m.note) continue;
            const url = normalizeUrl(m.meetingUrl);
            if (url && notedUrls.has(url)) continue;
            meetingsByKey.set(m.id, m);
            inputs.push({
                key: m.id,
                title: m.title,
                start: m.start,
                status: "",
                hasRecording: false,
                notePath: null,
            });
        }

        const rows = meetingRows(inputs, new Date(), direction);
        const pageSize = normalizePageSize(
            direction === "past"
                ? this.settings.dashboardPastPageSize
                : this.settings.dashboardUpcomingPageSize
        );
        const view = paginate(rows, pageSize, page);
        // Remember the page so an auto-refresh re-renders where the user is.
        el.dataset.mcPage = String(view.page);

        el.empty();

        if (calendarError) {
            el.createEl("p", {
                text: d.calendarError,
                cls: "mc-meetings-error",
            });
        }

        if (view.total === 0) {
            el.createEl("p", {
                text: direction === "past" ? d.pastEmpty : d.upcomingEmpty,
                cls: "mc-meetings-empty",
            });
        } else {
            const table = el.createEl("table", { cls: "mc-meetings" });
            const body = table.createEl("tbody");
            const pad = (n: number): string => String(n).padStart(2, "0");
            const timeStr = (dt: Date): string =>
                `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
            const dayKey = (dt: Date): string =>
                `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(
                    dt.getDate()
                )}`;
            const dayLabel = (dt: Date): string =>
                dt.toLocaleDateString(undefined, {
                    weekday: "short",
                    month: "short",
                    day: "numeric",
                });

            // Aggregate by day: a subheader row per date replaces a per-row
            // date column. Rows are already sorted, so a running key is enough.
            let lastDay = "";
            for (const row of view.rows) {
                const key = dayKey(row.start);
                if (key !== lastDay) {
                    lastDay = key;
                    const dayTr = body.createEl("tr", {
                        cls: "mc-meetings-dayrow",
                    });
                    dayTr.createEl("td", {
                        cls: "mc-meetings-day",
                        text: dayLabel(row.start),
                        attr: { colspan: "2" },
                    });
                }

                const tr = body.createEl("tr");
                const file = row.notePath
                    ? notesByPath.get(row.notePath)
                    : null;

                // Time + title in one column; the time is a fixed-width prefix.
                const whenTd = tr.createEl("td", { cls: "mc-meetings-when" });
                whenTd.createSpan({
                    cls: "mc-meetings-time",
                    text: timeStr(row.start),
                });
                if (file) {
                    const link = whenTd.createEl("a", {
                        text: row.title,
                        cls: "mc-meetings-title internal-link",
                    });
                    link.onclick = (e): void => {
                        e.preventDefault();
                        this.openFileInTab(file);
                    };
                } else {
                    // No note yet: plain (non-link) title. The create-note icon
                    // in the trailing cell already signals there's no note, so
                    // there's no "No note" status text.
                    whenTd.createSpan({
                        text: row.title,
                        cls: "mc-meetings-title mc-meeting-nonote",
                    });
                }

                // Trailing cell merges the old Status + Actions columns: for a
                // noted row, a colour-coded status dot (status is its tooltip);
                // for a note-less row, the create-note icon. Both centre in a
                // fixed-width cell so a lone dot lines up with the icon above.
                const trailTd = tr.createEl("td", { cls: "mc-meetings-trail" });
                if (row.notePath && row.status && row.status !== "—") {
                    const label =
                        (d.status as Record<string, string>)[row.status] ??
                        row.status;
                    const dot = trailTd.createSpan({
                        cls: `mc-status-dot mc-status-${row.status}`,
                    });
                    dot.setAttribute("aria-label", label);
                } else if (!row.notePath) {
                    const meeting = meetingsByKey.get(row.key);
                    if (meeting) {
                        const create = trailTd.createEl("button", {
                            cls: "mc-icon-btn",
                        });
                        setIcon(create, "file-plus");
                        create.setAttribute("aria-label", d.createNote);
                        create.onclick = (e): void => {
                            e.preventDefault();
                            void this.createNoteOnly(meeting).then(() =>
                                this.renderMeetingsSection(
                                    el,
                                    direction,
                                    view.page
                                )
                            );
                        };
                    }
                }
            }
        }

        this.renderDashToolbar(el, {
            countText:
                direction === "past"
                    ? d.pastCount(view.total)
                    : d.upcomingCount(view.total),
            legend: [
                { cls: "mc-status-scheduled", label: d.status.scheduled },
                { cls: "mc-status-recorded", label: d.status.recorded },
                { cls: "mc-status-transcribed", label: d.status.transcribed },
                { cls: "mc-status-enriched", label: d.status.enriched },
            ],
            pageSize,
            view,
            onPageSize: (n): void => {
                if (direction === "past") {
                    this.settings.dashboardPastPageSize = n;
                } else {
                    this.settings.dashboardUpcomingPageSize = n;
                }
                void this.saveSettings();
                // A different page size shifts every boundary; back to page 1.
                void this.renderMeetingsSection(el, direction, 1);
            },
            onGoTo: (p): void => void this.renderMeetingsSection(el, direction, p),
            onRefresh: (): void =>
                void this.renderMeetingsSection(el, direction, view.page, true),
        });

        restoreScroll();
    }

    /**
     * Shared bottom toolbar for the dashboard's paginated sections: a count on
     * the left, and on the right the per-page dropdown, prev/next + "page x of
     * y" (only when there's more than one page), and a circular refresh icon.
     * Callbacks re-render the owning section.
     */
    private renderDashToolbar(
        parent: HTMLElement,
        opts: {
            countText: string;
            pageSize: number;
            view: Page<unknown>;
            onPageSize: (size: number) => void;
            onGoTo: (page: number) => void;
            onRefresh: () => void;
            /** Optional status colour key rendered on the left of the bar. */
            legend?: Array<{ cls: string; label: string }>;
        }
    ): void {
        const c = t().dashboard.controls;
        const bar = parent.createDiv({ cls: "mc-dash-toolbar" });
        const left = bar.createDiv({ cls: "mc-dash-toolbar-left" });
        left.createSpan({ cls: "mc-dash-count", text: opts.countText });
        if (opts.legend) {
            const legend = left.createDiv({ cls: "mc-dash-legend" });
            for (const item of opts.legend) {
                const li = legend.createSpan({ cls: "mc-dash-legend-item" });
                li.createSpan({ cls: `mc-status-dot ${item.cls}` });
                li.createSpan({
                    cls: "mc-dash-legend-label",
                    text: item.label,
                });
            }
        }

        const right = bar.createDiv({ cls: "mc-dash-toolbar-right" });

        const perPage = right.createDiv({ cls: "mc-dash-perpage" });
        perPage.createSpan({ text: c.perPage });
        const select = perPage.createEl("select", { cls: "dropdown" });
        for (const size of PAGE_SIZE_OPTIONS) {
            select.createEl("option", {
                text: String(size),
                value: String(size),
            });
        }
        select.value = String(opts.pageSize);
        select.onchange = (): void =>
            opts.onPageSize(normalizePageSize(Number(select.value)));

        if (opts.view.pageCount > 1) {
            const nav = right.createDiv({ cls: "mc-pagination" });
            const prev = nav.createEl("button", { cls: "mc-icon-btn" });
            setIcon(prev, "chevron-left");
            prev.setAttribute("aria-label", c.prev);
            prev.disabled = opts.view.page <= 1;
            prev.onclick = (): void => opts.onGoTo(opts.view.page - 1);
            nav.createSpan({
                cls: "mc-pagination-status",
                text: c.pageOf(opts.view.page, opts.view.pageCount),
            });
            const next = nav.createEl("button", { cls: "mc-icon-btn" });
            setIcon(next, "chevron-right");
            next.setAttribute("aria-label", c.next);
            next.disabled = opts.view.page >= opts.view.pageCount;
            next.onclick = (): void => opts.onGoTo(opts.view.page + 1);
        }

        const refresh = right.createEl("button", { cls: "mc-icon-btn" });
        setIcon(refresh, "refresh-cw");
        refresh.setAttribute("aria-label", c.refresh);
        refresh.onclick = (): void => opts.onRefresh();
    }

    /** Per-action-items-block Component owning the current render's task markdown. */
    private actionRenderers: WeakMap<HTMLElement, Component> = new WeakMap();

    /** Live action-item render Components, so `onunload` can tear them all down. */
    private liveActionRenderers: Set<Component> = new Set();

    /**
     * Monotonic render id per dashboard block element. Async renders (calendar
     * fetch, vault scan) capture the id at start and bail before mutating the
     * DOM if a newer render superseded them — so fast paging/Refresh can't let
     * a slow earlier pass overwrite the latest UI.
     */
    private renderSeq: WeakMap<HTMLElement, number> = new WeakMap();

    /** Bumps and returns this element's render id. */
    private nextRenderSeq(el: HTMLElement): number {
        const seq = (this.renderSeq.get(el) ?? 0) + 1;
        this.renderSeq.set(el, seq);
        return seq;
    }

    /** Live dashboard block elements → their in-place re-render closure. */
    private dashboardBlocks: Map<HTMLElement, () => void> = new Map();
    private dashboardRefreshTimer: number | null = null;

    /** Registers a dashboard block for auto-refresh on the next change. */
    private trackDashboardBlock(el: HTMLElement, rerender: () => void): void {
        this.dashboardBlocks.set(el, rerender);
    }

    /** The block's last-rendered (1-based) page, stashed on the element. */
    private blockPage(el: HTMLElement): number {
        const n = Number.parseInt(el.dataset.mcPage ?? "", 10);
        return Number.isFinite(n) && n > 0 ? n : 1;
    }

    /** Debounced re-render of every connected dashboard block after a change. */
    private scheduleDashboardRefresh(): void {
        if (this.dashboardRefreshTimer !== null) {
            window.clearTimeout(this.dashboardRefreshTimer);
        }
        this.dashboardRefreshTimer = window.setTimeout(() => {
            this.dashboardRefreshTimer = null;
            for (const [el, rerender] of this.dashboardBlocks) {
                if (!el.isConnected) {
                    this.dashboardBlocks.delete(el);
                    continue;
                }
                rerender();
            }
        }, 400);
    }

    /**
     * Short-lived cache of the (whole-vault, disk-read) action-items scan so
     * paging/page-size changes reuse it instead of re-reading every task note.
     * A tick or Refresh forces a fresh scan (`force`). Keyed by section heading.
     */
    private actionScanCache: Map<
        string,
        { at: number; groups: ActionNoteGroup[] }
    > = new Map();

    /** Runs (or reuses, within a short TTL) a section-scoped task scan. */
    private async scanActionGroups(
        sectionHeading: string,
        force: boolean
    ): Promise<ActionNoteGroup[]> {
        const TTL_MS = 15_000;
        const cached = this.actionScanCache.get(sectionHeading);
        if (!force && cached && Date.now() - cached.at < TTL_MS) {
            return cached.groups;
        }
        const groups = sortActionNoteGroups(
            await this.scanOpenTaskNotes(sectionHeading)
        );
        this.actionScanCache.set(sectionHeading, {
            at: Date.now(),
            groups,
        });
        return groups;
    }

    /**
     * Renders the dashboard's "Open action items" section: notes with open
     * tasks under `## Action items`, grouped by note and ordered newest note
     * first, kept dense and paginated (by note). Each group shows a small
     * linked title + date and its open tasks; ticking a task marks it done in
     * the source note and re-renders. `page` is 1-based (by note).
     */
    private async renderActionItems(
        el: HTMLElement,
        page = 1,
        force = false
    ): Promise<void> {
        await this.renderTaskSection(el, {
            heading: ACTION_ITEMS_HEADING,
            strings: t().dashboard.actions,
            pageSizeKey: "dashboardActionsPageSize",
            page,
            force,
            showAge: false,
            horizonDays: 0,
        });
    }

    /**
     * Renders the dashboard's "Meeting follow-ups" section: open tasks under
     * `## Follow-ups`, horizon-filtered so the list stays bounded. "Show older"
     * reveals items past the horizon without permanently bloating the view.
     */
    private async renderFollowUps(
        el: HTMLElement,
        page = 1,
        force = false
    ): Promise<void> {
        await this.renderTaskSection(el, {
            heading: FOLLOW_UPS_HEADING,
            strings: t().dashboard.followups,
            pageSizeKey: "dashboardFollowupsPageSize",
            page,
            force,
            showAge: true,
            horizonDays: this.settings.followUpHorizonDays,
        });
    }

    /**
     * Shared renderer for the action-items and follow-ups dashboard sections.
     * `strings` is the i18n block (`actions` or `followups`); horizon filtering
     * only applies when `horizonDays > 0`.
     */
    private async renderTaskSection(
        el: HTMLElement,
        opts: {
            heading: string;
            strings: {
                count: (n: number) => string;
                empty: string;
                emptyRecent?: string;
                loading: string;
                taskMoved: string;
                taskError: (msg: string) => string;
                showOlder?: (n: number) => string;
                hideOlder?: string;
                ageDays?: (n: number) => string;
            };
            pageSizeKey: "dashboardActionsPageSize" | "dashboardFollowupsPageSize";
            page: number;
            force: boolean;
            showAge: boolean;
            horizonDays: number;
        }
    ): Promise<void> {
        const a = opts.strings;
        const seq = this.nextRenderSeq(el);
        const restoreScroll = this.preserveScroll(el);
        if (el.childElementCount === 0) {
            el.createEl("p", { text: a.loading, cls: "mc-actions-loading" });
        }

        const allGroups = await this.scanActionGroups(opts.heading, opts.force);
        if (this.renderSeq.get(el) !== seq) return;

        const today = new Date();
        const split = splitByHorizon(allGroups, opts.horizonDays, today);
        const showOlder = el.dataset.mcShowOlder === "1";
        const groups = showOlder
            ? sortActionNoteGroups(
                  mergeGroupsByPath([...split.recent, ...split.older])
              )
            : split.recent;
        const olderCount = countTasks(split.older);

        const pageSize = normalizePageSize(this.settings[opts.pageSizeKey]);
        const view = paginate(groups, pageSize, opts.page);
        el.dataset.mcPage = String(view.page);

        const prevRenderer = this.actionRenderers.get(el);
        if (prevRenderer) {
            prevRenderer.unload();
            this.liveActionRenderers.delete(prevRenderer);
        }
        const renderer = new Component();
        renderer.load();
        this.actionRenderers.set(el, renderer);
        this.liveActionRenderers.add(renderer);

        el.empty();

        if (view.total === 0 && olderCount === 0) {
            el.createEl("p", { text: a.empty, cls: "mc-actions-empty" });
        } else if (view.total === 0 && olderCount > 0 && !showOlder) {
            el.createEl("p", {
                text: a.emptyRecent ?? a.empty,
                cls: "mc-actions-empty",
            });
        } else {
            const list = el.createDiv({
                cls: opts.showAge
                    ? "mc-actions-list mc-followups-list"
                    : "mc-actions-list",
            });
            for (const group of view.rows) {
                this.renderActionNote(
                    list,
                    group,
                    el,
                    view.page,
                    renderer,
                    opts,
                    today
                );
            }
        }

        if (olderCount > 0 && a.showOlder && a.hideOlder) {
            const olderBar = el.createDiv({ cls: "mc-actions-older" });
            const btn = olderBar.createEl("button", {
                cls: "mc-actions-older-btn",
                text: showOlder ? a.hideOlder : a.showOlder(olderCount),
            });
            btn.onclick = (): void => {
                el.dataset.mcShowOlder = showOlder ? "0" : "1";
                void this.renderTaskSection(el, { ...opts, page: 1, force: false });
            };
        }

        this.renderDashToolbar(el, {
            countText: a.count(countTasks(groups)),
            pageSize,
            view,
            onPageSize: (n): void => {
                this.settings[opts.pageSizeKey] = n;
                void this.saveSettings();
                void this.renderTaskSection(el, { ...opts, page: 1, force: false });
            },
            onGoTo: (p): void =>
                void this.renderTaskSection(el, { ...opts, page: p, force: false }),
            onRefresh: (): void =>
                void this.renderTaskSection(el, {
                    ...opts,
                    page: view.page,
                    force: true,
                }),
        });

        restoreScroll();
    }

    /** Renders one note's group of open tasks in the action-items list. */
    private renderActionNote(
        parent: HTMLElement,
        group: ActionNoteGroup,
        sectionEl: HTMLElement,
        page: number,
        renderer: Component,
        opts: {
            heading: string;
            strings: {
                count: (n: number) => string;
                empty: string;
                emptyRecent?: string;
                loading: string;
                taskMoved: string;
                taskError: (msg: string) => string;
                showOlder?: (n: number) => string;
                hideOlder?: string;
                ageDays?: (n: number) => string;
            };
            pageSizeKey: "dashboardActionsPageSize" | "dashboardFollowupsPageSize";
            page: number;
            force: boolean;
            showAge: boolean;
            horizonDays: number;
        },
        today: Date
    ): void {
        const note = parent.createDiv({ cls: "mc-action-note" });
        const header = note.createDiv({ cls: "mc-action-note-header" });
        const file = this.app.vault.getAbstractFileByPath(group.path);
        const title = header.createEl("a", {
            cls: "mc-action-note-title internal-link",
            text: group.title,
        });
        title.onclick = (e): void => {
            e.preventDefault();
            if (file instanceof TFile) this.openFileInTab(file);
        };
        if (group.date) {
            const dt = group.date;
            const pad = (n: number): string => String(n).padStart(2, "0");
            header.createSpan({
                cls: "mc-action-note-date",
                text: `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(
                    dt.getDate()
                )}`,
            });
        }

        const ul = note.createEl("ul", { cls: "mc-action-tasks" });
        for (const task of group.tasks) {
            const li = ul.createEl("li", {
                cls: task.done
                    ? "mc-action-task mc-action-task-done"
                    : "mc-action-task",
            });
            const cb = li.createEl("input", {
                cls: "mc-action-task-check",
                type: "checkbox",
            });
            if (task.done) {
                cb.checked = true;
                cb.disabled = true;
            } else {
                cb.onclick = (): void => {
                    cb.disabled = true;
                    void (async (): Promise<void> => {
                        try {
                            await this.completeTask(
                                group.path,
                                task,
                                opts.strings.taskMoved
                            );
                        } catch (e) {
                            cb.disabled = false;
                            cb.checked = false;
                            new Notice(
                                opts.strings.taskError(
                                    e instanceof Error ? e.message : String(e)
                                )
                            );
                            return;
                        }
                        await this.renderTaskSection(sectionEl, {
                            ...opts,
                            page,
                            force: true,
                        });
                    })();
                };
            }
            const text = li.createSpan({ cls: "mc-action-task-text" });
            void MarkdownRenderer.render(
                this.app,
                task.text,
                text,
                group.path,
                renderer
            );
            if (opts.showAge && opts.strings.ageDays) {
                const age = taskAgeDays(task, group.date, today);
                if (age !== null && age > 0) {
                    li.createSpan({
                        cls: "mc-action-task-age",
                        text: opts.strings.ageDays(age),
                    });
                }
            }
        }
    }

    /**
     * Scans every note in the vault for open (`- [ ]`) tasks under
     * `sectionHeading`, returning a group per note with its title, origin
     * date, and task lines. Kept whole-vault on purpose: action items live in
     * meeting notes wherever they came from (including Granola-synced notes,
     * which carry no `event_id`).
     *
     * The metadata cache only *pre-filters* to files that (may) have an open
     * task — cheap, and avoids reading files with none — but the tasks
     * themselves are re-derived from a fresh disk read. That way a Refresh
     * reflects the current vault rather than a stale cache: a file the index
     * still lists but that has since moved/vanished (e.g. an external reorg
     * Obsidian hasn't fully re-indexed) fails the read and is dropped, instead
     * of lingering with tasks pointing at a folder that no longer exists.
     */
    private async scanOpenTaskNotes(
        sectionHeading: string
    ): Promise<ActionNoteGroup[]> {
        const today = this.todayStamp();
        const groups: ActionNoteGroup[] = [];
        for (const file of this.app.vault.getMarkdownFiles()) {
            const cache = this.app.metadataCache.getFileCache(file);
            const mayHaveTasks = (cache?.listItems ?? []).some(
                (it) => it.task !== undefined
            );
            if (!mayHaveTasks) continue;

            let content: string;
            try {
                content = await this.app.vault.read(file);
            } catch {
                continue;
            }
            const tasks = parseNoteTasks(content, today, sectionHeading);
            if (tasks.length === 0) continue;

            const fm = cache?.frontmatter as
                | Record<string, unknown>
                | undefined;
            const titleRaw = fm?.["title"];
            const title =
                typeof titleRaw === "string" && titleRaw
                    ? titleRaw
                    : file.basename;
            groups.push({
                path: file.path,
                title,
                date: this.resolveNoteDate(file, fm),
                tasks,
            });
        }
        return groups;
    }

    /** Local `YYYY-MM-DD` for today (the `✅` completion date we write/match). */
    private todayStamp(): string {
        const now = new Date();
        const pad = (n: number): string => String(n).padStart(2, "0");
        return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(
            now.getDate()
        )}`;
    }

    /**
     * Best-effort "when did this note happen" for ordering the action-items
     * list: a `start`/`date`/`created` frontmatter stamp, else a leading
     * `YYYY-MM-DD` in the filename (Granola's convention), else the file mtime.
     */
    private resolveNoteDate(
        file: TFile,
        fm: Record<string, unknown> | undefined
    ): Date | null {
        const fromFm = (k: string): Date | null => {
            const v = fm?.[k];
            if (typeof v !== "string" || !v) return null;
            const d = parseStampDate(v);
            return Number.isNaN(d.getTime()) ? null : d;
        };
        const stamped = fromFm("start") ?? fromFm("date") ?? fromFm("created");
        if (stamped) return stamped;
        const m = file.basename.match(/^(\d{4}-\d{2}-\d{2})/);
        if (m) {
            const d = parseStampDate(m[1]!);
            if (!Number.isNaN(d.getTime())) return d;
        }
        const mtime = file.stat?.mtime;
        return typeof mtime === "number" ? new Date(mtime) : null;
    }

    /**
     * Marks a scanned task done in its source note. The captured line index is
     * used when it still holds the task; otherwise the original line text is
     * located afresh (the note may have changed since the scan). The first
     * `[ ]` checkbox on that line becomes `[x]` and a `✅ YYYY-MM-DD` completion
     * date (today) is appended — Obsidian-Tasks compatible, and what the
     * dashboard reads to keep the item visible until that day is over.
     */
    private async completeTask(
        path: string,
        task: ActionTask,
        movedNotice = t().dashboard.actions.taskMoved
    ): Promise<void> {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) return;
        const lines = (await this.app.vault.read(file)).split("\n");
        let idx = task.line;
        if (lines[idx] !== task.raw) {
            idx = lines.findIndex((l) => l === task.raw);
        }
        if (idx < 0) {
            new Notice(movedNotice);
            return;
        }
        const checked = lines[idx]!.replace(/\[[^\]]\]/, "[x]");
        lines[idx] = this.appendCompletionDate(checked, this.todayStamp());
        await this.app.vault.modify(file, lines.join("\n"));
    }

    /**
     * Appends a `✅ YYYY-MM-DD` completion date to a task line, unless it
     * already has one. A trailing block reference (` ^id`) is kept at the end
     * of the line (Obsidian requires it there) with the date inserted before.
     */
    private appendCompletionDate(line: string, dateStr: string): string {
        if (/✅\s*\d{4}-\d{2}-\d{2}/.test(line)) return line;
        const mark = `✅ ${dateStr}`;
        const ref = line.match(/(\s+\^[A-Za-z0-9-]+)\s*$/);
        if (ref) {
            const head = line.slice(0, line.length - ref[0].length).trimEnd();
            return `${head} ${mark}${ref[0]}`;
        }
        return `${line.trimEnd()} ${mark}`;
    }

    /** Nearest scrollable ancestor of an element (the markdown view's scroller). */
    private scrollParent(el: HTMLElement): HTMLElement | null {
        let node: HTMLElement | null = el.parentElement;
        while (node) {
            const oy = getComputedStyle(node).overflowY;
            if (
                (oy === "auto" || oy === "scroll") &&
                node.scrollHeight > node.clientHeight
            ) {
                return node;
            }
            node = node.parentElement;
        }
        return null;
    }

    /**
     * Snapshots the section's scroll position and returns a fn that restores
     * it. Re-rendering a dashboard section empties and rebuilds its element,
     * which otherwise makes the view jump (usually to the top) on a task tick,
     * a page change, or Refresh; call the returned fn once the new content is
     * in place. The rAF re-apply covers async renders whose height settles a
     * frame later.
     */
    private preserveScroll(el: HTMLElement): () => void {
        const scroller = this.scrollParent(el);
        const top = scroller ? scroller.scrollTop : 0;
        return (): void => {
            if (!scroller) return;
            // Re-apply across the next few frames (and a macrotask): async
            // markdown rendering in the action list settles its height a frame
            // or two after the initial rebuild, and a single restore would be
            // undone by that late reflow — leaving the view jumped.
            const apply = (): void => {
                scroller.scrollTop = top;
            };
            apply();
            window.requestAnimationFrame(() => {
                apply();
                window.requestAnimationFrame(apply);
            });
            window.setTimeout(apply, 0);
        };
    }

    /** Opens a file in the active tab (used by dashboard row links/buttons). */
    private openFileInTab(file: TFile): void {
        void this.app.workspace.getLeaf(false).openFile(file);
    }

    /** Builds an AgendaMeeting view-model from a meeting note's frontmatter. */
    private agendaMeetingFromNote(file: TFile): AgendaMeeting {
        const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ??
            {}) as Record<string, unknown>;
        const str = (k: string): string => {
            const v = fm[k];
            return typeof v === "string" ? v : "";
        };
        // Fall back to "now" for missing/invalid dates so time-based actions
        // (e.g. create-and-record path templates) don't produce "Invalid Date".
        // A bare `YYYY-MM-DD` stamp (see `parseStampDate`) is treated as local
        // midnight rather than `new Date`'s UTC midnight.
        const toDate = (v: unknown): Date => {
            const d = typeof v === "string" ? parseStampDate(v) : new Date(NaN);
            return isNaN(d.getTime()) ? new Date() : d;
        };

        let recording: TFile | null = null;
        const link = recordingLinkTarget(fm["recording"]);
        if (link) {
            const dest = this.app.metadataCache.getFirstLinkpathDest(
                link,
                file.path
            );
            if (dest instanceof TFile) recording = dest;
        }

        return {
            id: str("event_id"),
            title: str("title") || file.basename,
            start: toDate(fm["start"] ?? fm["date"]),
            end: toDate(fm["end"] ?? fm["start"] ?? fm["date"]),
            allDay: false,
            meetingUrl: str("meeting_url") || null,
            location: str("location"),
            htmlLink: "",
            attendees: Array.isArray(fm["attendees"])
                ? (fm["attendees"] as unknown[]).map((x) => String(x))
                : [],
            organizer: str("organizer") || null,
            iCalUID: str("ical_uid") || null,
            recurringEventId: str("recurring_event_id") || null,
            oneOnOnePartner: str("one_on_one_with") || null,
            oneOnOnePartnerEmail: str("one_on_one_email") || null,
            note: file,
            recording,
            status: str("status") || null,
        };
    }

    /** Row handlers wired to the plugin, for menus shown outside the agenda view. */
    private noteRowHandlers(): RowHandlers {
        return {
            onOpenOrCreate: (m) => void this.openOrCreateNote(m),
            onCreateAndRecord: (m) => this.startRecordingForMeeting(m),
            onCreateNote: (m) => void this.createNoteOnly(m),
            onStop: () => this.stopRecording(),
            onOpenRecording: (m) => void this.openRecording(m),
            onTranscribe: (m, mode) => void this.transcribeRecording(m, mode),
            onEnrich: (m) => {
                if (m.note) void this.enqueueEnrich(m.note);
            },
            onOpenLink: (m) => {
                if (m.meetingUrl) this.openMeetingLink(m.meetingUrl);
            },
            onCopyLink: (m) => {
                if (m.meetingUrl) void this.copyMeetingLink(m.meetingUrl);
            },
            onSkip: () => {},
            isRecordingThis: (m) => this.isRecordingMeeting(m),
        };
    }

    private async fetchAgendaMeetings(
        fromMs: number,
        toMs: number
    ): Promise<AgendaMeeting[]> {
        const events = await listEvents(
            this.oauth,
            this.settings.calendarId,
            new Date(fromMs),
            new Date(toMs),
            250,
            parseKeywords(this.settings.exclusionKeywords)
        );
        const index = buildNoteIndex(this.app);
        return events
            .map((e) => toAgendaMeeting(e, index))
            .sort((a, b) => a.start.getTime() - b.start.getTime());
    }

    private async openOrCreateNote(m: AgendaMeeting): Promise<void> {
        if (m.note) {
            await this.app.workspace.getLeaf(false).openFile(m.note);
            return;
        }
        await this.createNoteOnly(m);
    }

    private async createNoteOnly(m: AgendaMeeting): Promise<void> {
        try {
            const ref = await createMeetingNote(
                this.app,
                agendaToMeetingInfo(m),
                this.noteConfig()
            );
            await this.app.workspace.getLeaf(false).openFile(ref.file);
            this.agendaEvents.emit("changed", undefined);
        } catch (e) {
            new Notice(
                t().notices.recordingError(
                    e instanceof Error ? e.message : String(e)
                )
            );
        }
    }

    private async openRecording(m: AgendaMeeting): Promise<void> {
        if (!m.recording) {
            new Notice(t().agenda.notices.noRecording);
            return;
        }
        await this.app.workspace.getLeaf(false).openFile(m.recording);
    }

    /**
     * Transcribes the meeting's recording with the built-in engine.
     *
     * `mode` selects the pass: "auto" respects the speaker-separation setting
     * (used by the auto-transcribe pipeline), while "diarized" / "mixed" let the
     * user force separation on or off from the menus regardless of the setting.
     */
    private async transcribeRecording(
        m: AgendaMeeting,
        mode: TranscribeMode = "auto"
    ): Promise<void> {
        if (!m.recording) {
            new Notice(t().agenda.notices.noRecording);
            return;
        }
        // A manual transcribe supersedes any auto-wait still pending for this
        // take — covers the multi-take rebuild path below, which doesn't go
        // through launchTranscriber (so its own cancellation wouldn't fire).
        this.cancelPendingAutoTranscribe(m.recording.path);
        // A manual re-transcribe REPLACES the transcript. With several takes,
        // transcribing only the latest and replacing would drop the earlier
        // ones' text, so rebuild the whole transcript from every take in one
        // atomic write (see rebuildTranscriptFromTakes). A single take falls
        // through to the plain replace path. Route on the number of linked takes
        // (not resolved files) so a missing audio file can't silently downgrade
        // a multi-take note to a single-take replace that wipes earlier text —
        // the rebuild detects the missing file and aborts instead.
        const linkCount = m.note ? this.recordingLinkCount(m.note) : 0;
        if (m.note && linkCount > 1) {
            await this.rebuildTranscriptFromTakes(m.note, linkCount, mode);
            return;
        }
        await this.launchTranscriber(m.recording, mode);
    }

    /** How many recordings a note's `recording` frontmatter links (array-aware). */
    private recordingLinkCount(note: TFile): number {
        const fm = this.app.metadataCache.getFileCache(note)?.frontmatter as
            | Record<string, unknown>
            | undefined;
        return recordingLinkTargets(fm?.["recording"]).length;
    }

    /** Resolves a note's linked recording(s) to TFiles, in chronological order. */
    private resolveRecordingTakes(note: TFile): TFile[] {
        const fm = this.app.metadataCache.getFileCache(note)?.frontmatter as
            | Record<string, unknown>
            | undefined;
        const out: TFile[] = [];
        for (const link of recordingLinkTargets(fm?.["recording"])) {
            const dest = this.app.metadataCache.getFirstLinkpathDest(
                link,
                note.path
            );
            if (dest instanceof TFile) out.push(dest);
        }
        return out;
    }

    /**
     * True when me-vs-them speaker separation should run: the user enabled it
     * and the current endpoint + model has been probed and confirmed to return
     * timestamps. Gates both the split at record time and the diarized pass at
     * transcribe time.
     *
     * The local Whisper engine always emits segment timestamps, so it bypasses
     * the remote timestamp probe entirely and honors the user's toggle directly
     * — the probe only describes the remote endpoint's behavior, which is moot
     * on-device. For the remote backend the probe gate still applies, so a
     * doomed diarized pass never runs against an endpoint that ignores it.
     */
    private shouldSeparateSpeakers(): boolean {
        if (this.settings.transcriptionBackend === "local") {
            return this.settings.diarizationEnabled;
        }
        return canSeparateSpeakers(
            this.settings,
            probeKey(this.settings.apiBaseUrl, this.settings.sttModel)
        );
    }

    /** Absolute path where the given local model file lives (or would live). */
    localModelPath(spec: LocalModelSpec): string {
        return resolveModelPath(this, spec.fileName);
    }

    /**
     * True when the model file is present on disk at its expected size. A
     * partial/interrupted download (wrong size) reads as absent so the UI
     * offers to re-download rather than treating it as ready.
     */
    async localModelPresent(spec: LocalModelSpec): Promise<boolean> {
        try {
            const st = await fs.promises.stat(this.localModelPath(spec));
            return st.size === spec.sizeBytes;
        } catch {
            return false;
        }
    }

    /**
     * Ensures the model is downloaded and SHA-256-verified, streaming it to disk
     * on first use and reusing it thereafter. `onProgress` reports received /
     * total bytes for a download; it isn't called when the model is already
     * present.
     */
    ensureLocalModel(
        spec: LocalModelSpec,
        onProgress?: (received: number, total: number) => void,
        signal?: AbortSignal
    ): Promise<string> {
        return this.modelProvisioner.ensure(
            this.localModelPath(spec),
            spec.url,
            spec.sha256,
            spec.sizeBytes,
            {
                onDownloadStart: () => new Notice(t().notices.downloadingModel),
                // HF's CDN sometimes omits Content-Length after a redirect, so
                // the stream reports total=0; fall back to the registry's known
                // size so the UI can still show a real percentage.
                onProgress: onProgress
                    ? (received, total) =>
                          onProgress(received, total > 0 ? total : spec.sizeBytes)
                    : undefined,
                signal,
            }
        );
    }

    /** Deletes the model file if present (best-effort; a missing file is a no-op). */
    async deleteLocalModel(spec: LocalModelSpec): Promise<void> {
        try {
            await fs.promises.unlink(this.localModelPath(spec));
        } catch {
            // already gone / never downloaded — nothing to do
        }
    }

    /**
     * The engine family to send on the wire. The timestamp-intent Whisper
     * (`whisper-1-ts`) asks for `verbose_json`, which backends that don't emit
     * timestamps reject outright — so downgrade it to plain `whisper-1` unless
     * a fresh probe confirmed this endpoint + model actually returns segments.
     * Other families pass through unchanged.
     */
    private resolveEngineFamily(): SttApiType {
        const s = this.settings;
        if (s.sttApiType !== "whisper-1-ts") return s.sttApiType;
        const key = probeKey(s.apiBaseUrl, s.sttModel);
        const timestampsConfirmed =
            s.sttTimestampsProbeKey === key && s.sttTimestampsSupported === true;
        return timestampsConfirmed ? "whisper-1-ts" : "whisper-1";
    }

    /** Maps plugin settings onto the vendored transcription engine's config. */
    private buildTranscribeConfig(): TranscribeConfig {
        const s = this.settings;
        return {
            baseUrl: s.apiBaseUrl,
            apiKey: s.apiKey,
            // The engine family selects routing/chunking/timestamps; sttModel is
            // the actual name sent on the wire (may be a gateway id). Whisper
            // downgrades to no-timestamps when the endpoint can't emit them.
            model: this.resolveEngineFamily() as TranscriptionModel,
            modelOverride: s.sttModel,
            chatModel: s.enrichModel,
            language: s.sttLanguage || "auto",
            postProcessingEnabled: s.postProcessingEnabled,
            dictionaryCorrectionEnabled: s.dictionaryCorrectionEnabled,
            userDictionaries: parseDictionary(s.dictionary),
            debugMode: s.debugLogging,
        };
    }

    /**
     * The transcription backend for this run, built from current settings —
     * the OpenAI-compatible engine, or the on-device Whisper backend when the
     * user selected "local" (issue #34). A fresh instance per call is fine: the
     * serial queue guarding the remote engine's process-global endpoint seam is
     * shared at module scope, and the local backend holds no shared state.
     *
     * Async because the local path provisions its assets (helper, framework,
     * model) on first use before it can transcribe.
     */
    private async buildBackend(): Promise<TranscriptionBackend> {
        if (this.settings.transcriptionBackend === "local") {
            return this.buildLocalBackend();
        }
        return new OpenAICompatibleBackend(this.app, this.buildTranscribeConfig());
    }

    /**
     * Ensures the recorder helper is present *and launchable*: the verified
     * `system-recorder` binary plus the `whisper.framework` dylib it links
     * unconditionally at process start (issue #34). The shipped helper links
     * whisper for EVERY subcommand — `start` and `list-devices`, not just
     * `transcribe` — so without the co-located dylib dyld refuses to launch it
     * and recording/device enumeration break too, regardless of the chosen
     * transcription backend. Treating the two as one runtime unit keeps every
     * spawn path (record, enumerate, transcribe) self-consistent. Returns the
     * binary path; each ensure is a no-op once the asset is present + verified.
     */
    private async ensureHelperRuntime(): Promise<string> {
        const binaryPath = await this.provisioner.ensure(
            resolveBinaryPath(this),
            this.manifest.version,
            () => new Notice(t().notices.downloadingHelper)
        );
        await this.ensureWhisperDylib();
        return binaryPath;
    }

    /**
     * Fetches the whisper.cpp dylib to `whisper.framework/Versions/Current/whisper`
     * next to the helper (where its `@rpath/.../Versions/Current/whisper` load
     * command resolves via SwiftPM's `@loader_path` rpath). It's byte-identical
     * across our releases (pinned XCFramework), so the fixed SHA/size + the
     * provisioner's size fast-path make this a one-time fetch reused thereafter.
     */
    private ensureWhisperDylib(): Promise<string> {
        return this.modelProvisioner.ensure(
            resolveWhisperDylibPath(this),
            whisperDylibUrl(this.manifest.version),
            EXPECTED_WHISPER_SHA256,
            WHISPER_DYLIB_SIZE,
            {
                label: "recorder component",
                onDownloadStart: () => new Notice(t().notices.downloadingRuntime),
            }
        );
    }

    /**
     * Ensures `fvad.wasm` sits next to `main.js` so the diarized path can run
     * local WebRTC VAD (the hallucination filter). BRAT/community installs only
     * ship main.js/manifest/styles, so the file is otherwise absent — unlike a
     * `deploy:local` build, which copies it in. Byte-identical across releases
     * (immutable npm artifact), so the fixed SHA/size + the provisioner's size
     * fast-path make it a one-time fetch reused thereafter.
     *
     * **Best-effort**: local VAD is optional (it degrades to the recorder's RMS
     * windows), so a failed fetch (offline, older release without the asset)
     * must not break transcription. The caller swallows the rejection; we only
     * log at debug. Never shows a download Notice — it's a silent background
     * top-up, not a user-facing prerequisite like the model/helper.
     */
    private ensureFvadWasm(): Promise<string> {
        return this.modelProvisioner.ensure(
            resolveFvadWasmPath(this),
            fvadWasmUrl(this.manifest.version),
            EXPECTED_FVAD_SHA256,
            FVAD_WASM_SIZE,
            { label: "voice-activity detector" }
        );
    }

    /**
     * Provision fvad.wasm without ever stalling or failing the caller. A failed
     * fetch is logged at debug (VAD degrades to the RMS windows); a *slow* fetch
     * is time-boxed — `requestUrl` can't be aborted mid-flight, so on the cap we
     * proceed with the RMS fallback and let the download finish in the
     * background (its rejection is swallowed) so the next run finds it. Resolves
     * (never rejects) once the asset is present or the cap elapses.
     */
    private async ensureFvadWasmBestEffort(): Promise<void> {
        const provision = this.ensureFvadWasm().then(
            () => undefined,
            (e: unknown) => {
                console.debug(
                    "[Meeting Copilot][vad] fvad.wasm unavailable; using RMS fallback",
                    e
                );
            }
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cap = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, FVAD_PROVISION_TIMEOUT_MS);
        });
        try {
            await Promise.race([provision, cap]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    /**
     * The on-device Whisper backend, provisioning everything it needs on first
     * use: the recorder helper runtime (binary + linked framework) and the
     * selected ggml model. Each ensure is a no-op once present, so steady-state
     * adds no download — only the first local transcription (or a model switch)
     * pays for it, behind its own progress notice.
     */
    private async buildLocalBackend(): Promise<TranscriptionBackend> {
        const binaryPath = await this.ensureHelperRuntime();
        const spec = localModelSpec(this.settings.localWhisperModel);
        const modelPath = await this.ensureLocalModel(spec);
        return new WhisperCppBackend(
            {
                binaryPath,
                modelPath,
                language: this.settings.sttLanguage || "auto",
            },
            whisperCppNodeDeps(this)
        );
    }

    /**
     * Whether a failed local transcription should retry against the remote
     * service: only when the user enabled the fallback, an endpoint is
     * configured, and the failure wasn't a user cancellation (which must
     * propagate as a cancel, not be masked by a fallback pass). The caller also
     * gates on the intended backend actually being local.
     */
    private canFallbackToRemote(error: unknown, signal: AbortSignal): boolean {
        return (
            this.settings.localFallbackToRemote &&
            !isDiarizationCancelled(error, signal) &&
            !!this.settings.apiBaseUrl &&
            !!this.settings.apiKey
        );
    }

    /**
     * Runs the speaker-separated pass. Returns the diarized transcript, or null
     * when separation doesn't apply (no sidecars on disk) or the endpoint
     * returned no segments this pass and we fell back to the mixed file. It only
     * invalidates the cached probe when the fallback was a genuine capability
     * miss (no timestamps); a transient error leaves the probe intact so speaker
     * separation isn't disabled for future meetings.
     *
     * Whether to run this at all (respect the setting, or force it) is decided
     * by the caller. When `forced` (the user explicitly asked for separation) a
     * recording with no separate tracks surfaces a notice before falling back.
     */
    private async tryDiarizedTranscribe(
        recording: TFile,
        forced: boolean,
        backend: TranscriptionBackend,
        onProgress?: (percent: number) => void,
        signal?: AbortSignal
    ): Promise<string | null> {
        // Discover the split sidecars by naming convention so separation works
        // for both the auto-transcribe after stop and a manual re-run on an old
        // recording. The helper writes them straight to disk, so check the
        // adapter (which bypasses the vault-index lag) before waiting on the
        // TFile: a recording with no sidecars must not stall the retry loop.
        const sidecars = sidecarPathsFor(recording.path);
        const meFile = await this.resolveExistingFile(sidecars.me);
        const themFile = await this.resolveExistingFile(sidecars.them);
        if (!meFile || !themFile) {
            if (forced) new Notice(t().notices.diarizationNoTracks);
            return null;
        }

        // Speech windows gate out Whisper's silence hallucinations without
        // touching the audio (so the two streams keep their shared clock).
        // Prefer local WebRTC VAD — a real speech/non-speech classifier — over
        // the recorder's crude RMS gate, but merge per stream: if VAD found no
        // speech on a stream, fall back to the recorder's speech.json for that
        // stream (and to no filtering when neither is available).
        //
        // Make sure fvad.wasm is present first (BRAT installs don't ship it);
        // best-effort and time-boxed — a failed OR slow fetch just means
        // computeSpeechWindows falls back to the RMS gate, so it must never
        // stall or break the transcription.
        await this.ensureFvadWasmBestEffort();
        const localWindows = await computeSpeechWindows(this.app, meFile, themFile);
        let rmsWindows: SpeechWindows | undefined;
        const speech = await this.resolveExistingFile(sidecars.speech);
        if (speech) {
            rmsWindows = parseSpeechWindows(await this.app.vault.read(speech));
        }
        const windows = preferWindows(localWindows, rmsWindows);
        // Per-stream pre-gate provenance (issue #67): the diarized pre-gate
        // truncates each upload to these windows, a stronger contract than the
        // merge's touch-filter, so it needs to know which detector produced them
        // (VAD = trust, small pad; RMS-only = big pad; VAD-heard-nothing = full
        // pass). The `windows` above still gate the merge unchanged.
        const sources = pregateSources(localWindows, rmsWindows);
        const result = await transcribeDiarized(
            meFile,
            themFile,
            backend,
            windows,
            signal,
            onProgress,
            sources
        );
        if (result.diarized) return result.text;

        // A transient failure this run (a flaky chunk, a network blip) must not
        // be misread as "this endpoint can't do timestamps": that would null the
        // probe and silently disable speaker separation for every future meeting
        // until the user manually re-checks (issue #61). Only a genuine
        // capability miss warrants invalidating the probe.
        if (!shouldInvalidateProbe(result)) {
            console.warn(
                "[Meeting Copilot] diarization pass errored; using mixed audio for this meeting (probe left intact)"
            );
            return null;
        }

        // The endpoint didn't return timestamps this pass (a misconfiguration
        // slipping past the probe). Invalidate the cached probe so we stop
        // paying for three passes every meeting, and tell the user how to
        // re-check. The mixed pass runs back in launchTranscriber.
        console.warn(
            "[Meeting Copilot] diarization returned no segments; using mixed audio"
        );
        this.settings.sttTimestampsSupported = null;
        await this.saveSettings();
        new Notice(t().notices.diarizationNoTimestamps);
        return null;
    }

    /**
     * Resolves a vault path to a TFile only when the file actually exists on
     * disk. Checks the vault adapter first (no index lag) so a sidecar that was
     * never written returns immediately, then reuses the retry helper so a
     * just-written file gets time to land in the vault index.
     */
    private async resolveExistingFile(
        vaultPath: string
    ): Promise<TFile | null> {
        if (!(await this.app.vault.adapter.exists(vaultPath))) return null;
        return this.resolveFileWithRetry(vaultPath);
    }

    /**
     * Enqueues an audio file for headless transcription (no modal, no separate
     * transcript file). Transcriptions run one at a time through the visible
     * {@link TaskQueue}, so a second request waits (and is shown as queued)
     * rather than fighting the first. When enrichment is due (auto-enrich, or
     * the caller asked), it's chained as a *dependent* enrich task on the same
     * queue — visible in the popover, independently cancellable, and run only
     * after the transcription succeeds (a cancelled/failed transcribe drops it).
     *
     * `mode` picks the pass: "auto" respects the speaker-separation setting,
     * "diarized" forces the separated pass (falling back to the joint track when
     * no separate tracks exist), and "mixed" always transcribes the joint track.
     */
    private async launchTranscriber(
        recording: TFile,
        mode: TranscribeMode = "auto",
        opts: { fresh?: boolean; enrichAfter?: boolean } = {}
    ): Promise<void> {
        // "fresh" = the auto-transcribe fired right after a stop (vs. a manual
        // re-transcribe). The fresh path appends its transcript to any existing
        // one (so a new take extends the meeting) and may auto-discard an empty
        // result as silence; a manual re-transcribe replaces. A multi-take
        // manual rebuild has its own path (rebuildTranscriptFromTakes).
        const fresh = opts?.fresh ?? false;
        // A transcribe of this recording from any trigger (manual, or this very
        // auto run once the wait resolved) supersedes a still-pending auto-wait
        // for the same take — cancel it so it can't fire a duplicate later.
        this.cancelPendingAutoTranscribe(recording.path);
        // The remote backend needs an endpoint; the local one provisions its own
        // model/helper, so it can transcribe with no endpoint configured.
        if (
            this.settings.transcriptionBackend !== "local" &&
            (!this.settings.apiBaseUrl || !this.settings.apiKey)
        ) {
            new Notice(t().notices.transcribeNoEndpoint);
            return;
        }
        // Dedupe overlapping runs (double-click, or auto-transcribe racing a
        // manual trigger) — each would cost an API call and write.
        if (this.taskQueue.has(recording.path)) {
            new Notice(t().notices.transcribeInProgress);
            return;
        }
        const label = this.transcribeLabelFor(recording);
        // A run already occupies the single slot, so this one will wait; say so.
        if (this.taskQueue.snapshot().running) {
            new Notice(t().notices.transcribeQueued(label));
        }

        // A holder (not a closed-over `let`) so TypeScript keeps the value's type
        // after the await instead of narrowing it to the initializer.
        const enrichAfter: { value: { note: TFile; transcript: string } | null } = {
            value: null,
        };
        const transcribeDone = this.taskQueue.enqueue({
            id: recording.path,
            label,
            kind: "transcribe",
            run: async (signal) => {
                enrichAfter.value = await this.transcribeToNote(
                    recording,
                    label,
                    mode,
                    signal,
                    fresh
                );
            },
        });

        // Chain enrichment as a dependent queue task (issue #96): it shows in the
        // same popover, is independently cancellable, and runs only after the
        // transcription SUCCEEDS — a cancelled/failed transcribe drops it. Enrich
        // afterwards when auto-transcribe says so, or when the caller asked (the
        // user clicked Enrich on a not-yet-transcribed note).
        const shouldEnrich =
            this.settings.enableEnrichment &&
            (opts.enrichAfter || this.settings.enrichOnTranscribe);
        if (shouldEnrich) {
            const note = findMeetingNoteForAudio(this.app, recording);
            if (note) {
                void this.enqueueEnrichTask(note, {
                    dependsOn: recording.path,
                    // Pass the fresh transcript so enrichment works even when
                    // insertTranscript is off and the note has no transcript yet.
                    // Skip quietly if the run produced none (silence / no note).
                    resolveTranscript: () => enrichAfter.value?.transcript,
                    quiet: true,
                });
            }
        }

        try {
            await transcribeDone;
        } catch (e) {
            // Cancellation is expected; other failures were already surfaced with
            // their own notice/status inside transcribeToNote.
            if (!(e instanceof TaskCancelledError)) {
                console.warn("[Meeting Copilot] transcription failed", e);
            }
        }
    }

    /**
     * Transcribes one recording (take) to ready-to-insert text, without writing
     * to any note — the shared core of the single-take writer
     * ({@link transcribeToNote}) and the multi-take rebuild
     * ({@link rebuildTranscriptFromTakes}). Drives the shared progress bar and
     * classifies the outcome (see {@link TranscribeTakeResult}). User
     * cancellation throws {@link TaskCancelledError} so the queue
     * rejects; every other failure returns an "error"/"partial" result.
     */
    private async transcribeTakeToText(
        recording: TFile,
        label: string,
        mode: TranscribeMode,
        signal: AbortSignal
    ): Promise<TranscribeTakeResult> {
        // Single-owner progress: only the running job writes to the shared bar,
        // labelled with the meeting name (and any queued-behind count).
        const onProgress = (pct: number): void => {
            const snapshot = this.taskQueue.snapshot();
            if (snapshot.running?.id !== recording.path) {
                return;
            }
            const rounded = Math.round(pct);
            const changed = this.runningProgress?.pct !== rounded;
            this.runningProgress = { id: recording.path, pct: rounded };
            this.setActionStatus(
                this.transcribeStatusText(
                    label,
                    rounded,
                    this.taskQueue.waitingCount
                ),
                "busy"
            );
            // Progress ticks don't emit a queue transition, so an open popover
            // would freeze on a stale percent between tasks — refresh it here
            // (only when the rounded value actually moved, to avoid churn).
            if (changed && this.statusHovered) this.showQueuePopover(snapshot);
        };
        // New job: forget the previous run's percent until its first tick.
        this.runningProgress = null;
        this.setActionStatus(t().statusBar.transcribingNamed(label), "busy");
        const transcribeStart = Date.now();
        const sizeMb = (recording.stat?.size ?? 0) / (1024 * 1024);
        // console.warn so the timing line shows in Obsidian's console without
        // enabling Verbose logging (mirrors the vendored engine's own logger).
        console.warn(
            `[Meeting Copilot][transcribe] "${recording.name}" begin (mode=${mode}, size=${sizeMb.toFixed(1)}MB)`
        );
        try {
            // Decide whether to run speaker separation: "auto" defers to the
            // setting, "diarized" forces it on, "mixed" forces it off. A null
            // back from the diarized pass means it didn't apply or fell back, in
            // which case we transcribe the mixed wav (which always exists).
            const wantDiarized =
                mode === "diarized" ||
                (mode === "auto" && this.shouldSeparateSpeakers());
            // Whether the *intended* backend is local, sampled before building it
            // so a provisioning failure (model/helper download) can fall back too.
            const useLocal = this.settings.transcriptionBackend === "local";
            let diarized: boolean;
            let rawText: string;
            try {
                const backend = await this.buildBackend();
                const diarizedText = wantDiarized
                    ? await this.tryDiarizedTranscribe(
                          recording,
                          mode === "diarized",
                          backend,
                          onProgress,
                          signal
                      )
                    : null;
                diarized = diarizedText !== null;
                rawText =
                    diarizedText ??
                    (await transcribeAudio(recording, backend, signal, onProgress));
            } catch (e) {
                // On-device transcription can fail hard (model/helper missing, a
                // decode error, an OOM). When the user opted into "fall back to
                // remote" and an endpoint is configured, retry a plain mixed pass
                // against it — a degraded but working transcript beats none.
                // Diarization isn't retried remotely: its timestamp support isn't
                // probed on this path, and a mixed transcript is the safe floor.
                if (!(useLocal && this.canFallbackToRemote(e, signal))) throw e;
                console.warn(
                    "[Meeting Copilot] local transcription failed; falling back to the remote service",
                    e
                );
                // Say diarization was dropped when the user asked for it: the
                // remote fallback is always a plain mixed pass, so a forced
                // speaker-separated request silently becomes mixed otherwise.
                new Notice(
                    wantDiarized
                        ? t().notices.localFallbackNoDiarization
                        : t().notices.localFallback
                );
                // Reset the bar so the remote pass ramps 0→100 instead of jumping
                // backward from wherever the failed local attempt left it.
                onProgress(0);
                const remote = new OpenAICompatibleBackend(
                    this.app,
                    this.buildTranscribeConfig()
                );
                diarized = false;
                rawText = await transcribeAudio(recording, remote, signal, onProgress);
            }
            const totalSecs = ((Date.now() - transcribeStart) / 1000).toFixed(1);
            console.warn(
                `[Meeting Copilot][transcribe] "${recording.name}" transcription finished in ${totalSecs}s (diarized=${diarized}${
                    wantDiarized && !diarized ? ", fell back to mixed" : ""
                })`
            );
            // The diarized path already filters silence hallucinations per
            // segment before merging. The mixed path has no segment seam, so a
            // silent recording can come back as nothing but a stock YouTube-outro
            // phrase; strip those whole lines so it's treated as empty rather
            // than written out as a bogus note/title.
            const text = diarized ? rawText : stripHallucinatedLines(rawText);

            const trimmed = text.trim();
            if (!trimmed) {
                // Log the outcome: an empty result after filtering is a common
                // reason a re-transcribe "does nothing" — the note is left
                // untouched on purpose (we never overwrite a transcript with
                // nothing). Surfacing it makes that visible in the log instead
                // of the run just going silent.
                console.warn(
                    `[Meeting Copilot][transcribe] "${recording.name}" produced an empty transcript after filtering; note left unchanged`
                );
                return { kind: "empty" };
            }
            // A partial/failed run comes back as a marker-prefixed string
            // (not clean transcript text), so don't insert it as the transcript.
            if (isPartialTranscript(trimmed)) {
                return { kind: "partial" };
            }
            // Tell the reader (and the enrichment model) who "Me"/"Them" are,
            // so owner attribution of action items has something to go on.
            const finalText = diarized
                ? `${t().transcript.speakerBanner}\n\n${text}`
                : text;
            return { kind: "text", text: finalText };
        } catch (e) {
            // A user cancellation must propagate so the queue rejects (and the
            // caller skips enrichment); everything else is a recoverable failure
            // surfaced here.
            if (isDiarizationCancelled(e, signal)) {
                new Notice(t().notices.transcribeCancelled);
                this.setActionStatus(t().statusBar.transcribeCancelled, "error");
                // Re-throw as the queue's cancellation type so the caller's
                // guard treats it as an expected cancel (no "failed" log) —
                // matching the waiting-job path, which rejects with this error.
                throw new TaskCancelledError();
            }
            const msg = e instanceof Error ? e.message : String(e);
            // The engine throws the partial text (marker-prefixed) for a
            // partial/failed run rather than returning it, so classify it.
            if (isPartialTranscript(msg)) {
                return { kind: "partial" };
            }
            return { kind: "error", message: msg };
        }
    }

    /**
     * The single-take transcription pass run by the queue: transcribes one
     * recording and writes the result into its meeting note. Returns the note +
     * fresh transcript to enrich afterward, or null when there's nothing to
     * enrich (empty/partial/error result, or no owning note). A `fresh` take
     * (auto-transcribe right after a stop) APPENDS to any existing transcript so
     * a new take extends the meeting, and may auto-discard an empty result as
     * silence; a manual re-transcribe REPLACES. Throws only on cancellation, so
     * the queue rejects and the caller skips enrichment.
     */
    private async transcribeToNote(
        recording: TFile,
        label: string,
        mode: TranscribeMode,
        signal: AbortSignal,
        fresh = false
    ): Promise<{ note: TFile; transcript: string } | null> {
        const res = await this.transcribeTakeToText(recording, label, mode, signal);
        if (res.kind === "empty") {
            // A fresh recording with no speech is the "started before anyone
            // joined" throwaway — discard it (audio + link) so the meeting
            // re-offers record. Only on the fresh post-stop path: a manual
            // re-transcribe that comes back empty must never delete audio.
            // Safety net: if the recorder's own speech detection (split-mode
            // speech.json) found speech, an empty transcript is a transcription
            // miss, not silence — keep the audio rather than discard it.
            if (
                fresh &&
                this.settings.discardSilentRecordings &&
                !(await this.recordingHasSpeech(recording))
            ) {
                await this.discardSilentRecording(recording);
            } else {
                new Notice(t().notices.transcribeEmpty);
            }
            if (!this.recorder.isRecording) this.clearActionStatus();
            return null;
        }
        if (res.kind === "partial") {
            new Notice(t().notices.transcribePartial);
            this.setActionStatus(t().statusBar.transcribeFailed, "error");
            return null;
        }
        if (res.kind === "error") {
            new Notice(t().notices.transcribeError(res.message));
            this.setActionStatus(t().statusBar.transcribeFailed, "error");
            return null;
        }
        const finalText = res.text;
        const result = await this.handleTranscriptionCompleted(
            {
                audioFile: recording,
                transcription: finalText,
                file: null,
            },
            fresh
        );
        console.warn(
            `[Meeting Copilot][transcribe] "${recording.name}" completed: note ${
                result.note
                    ? "found and updated"
                    : "NOT found (no note matched this recording)"
            }`
        );
        if (!result.note) {
            new Notice(t().notices.transcribeNoNote(recording.basename));
            return null;
        }
        // The .me/.them/.speech sidecars are left in place: a later manual
        // re-transcribe reuses them, and the retention sweep ages them out
        // on the same rule as the audio.
        return { note: result.note, transcript: result.transcript ?? finalText };
    }

    /**
     * Manual re-transcribe for a note that owns several takes: transcribes every
     * take to text (through the queue, one at a time), then does a SINGLE atomic
     * replace of the note's transcript with all takes joined chronologically and
     * enriches once. All-or-nothing: the note is written only when EVERY take
     * produced text, so a missing audio file, an empty/partial/failed take, or a
     * cancellation mid-run leaves the existing (complete) transcript intact
     * rather than replacing it with a shorter rebuild. `expectedTakes` is the
     * number of linked takes, so an unresolvable link is caught as a missing
     * file instead of silently dropped.
     */
    private async rebuildTranscriptFromTakes(
        note: TFile,
        expectedTakes: number,
        mode: TranscribeMode
    ): Promise<void> {
        if (!this.settings.apiBaseUrl || !this.settings.apiKey) {
            new Notice(t().notices.transcribeNoEndpoint);
            return;
        }
        const takes = this.resolveRecordingTakes(note);
        // A linked take whose audio can't be resolved means we can't reproduce
        // the full transcript — abort rather than replace it with a rebuild that
        // silently omits the missing take.
        if (takes.length !== expectedTakes) {
            new Notice(t().notices.retranscribeIncomplete);
            if (!this.recorder.isRecording) this.clearActionStatus();
            return;
        }
        // Bail if any take is already queued/running (a fresh auto-transcribe,
        // or a double trigger) — rebuilding while one is in flight would
        // interleave writes.
        if (takes.some((take) => this.taskQueue.has(take.path))) {
            new Notice(t().notices.transcribeInProgress);
            return;
        }
        const label = this.meetingNoteLabel(note);
        const segments: string[] = [];
        let allText = true;
        try {
            for (const take of takes) {
                if (this.taskQueue.snapshot().running) {
                    new Notice(t().notices.transcribeQueued(label));
                }
                const outcome: { value: TranscribeTakeResult | null } = {
                    value: null,
                };
                await this.taskQueue.enqueue({
                    id: take.path,
                    label,
                    kind: "transcribe",
                    run: async (signal) => {
                        outcome.value = await this.transcribeTakeToText(
                            take,
                            label,
                            mode,
                            signal
                        );
                    },
                });
                const res = outcome.value;
                if (res?.kind === "text") {
                    segments.push(res.text);
                    continue;
                }
                // Any non-text outcome (empty/partial/error) means we can't
                // produce the complete transcript this run — remember that and
                // surface why, but keep going so the user sees every take's
                // outcome before we decide not to overwrite.
                allText = false;
                if (res?.kind === "partial")
                    new Notice(t().notices.transcribePartial);
                else if (res?.kind === "error")
                    new Notice(t().notices.transcribeError(res.message));
                else new Notice(t().notices.transcribeEmpty);
            }
        } catch (e) {
            // Cancellation (or an unexpected queue failure) mid-rebuild: leave
            // the existing transcript untouched rather than write a partial one.
            if (!(e instanceof TaskCancelledError)) {
                console.warn("[Meeting Copilot] transcript rebuild failed", e);
            }
            return;
        }
        if (!allText || segments.length === 0) {
            // Some take didn't come back as clean text: don't overwrite the
            // existing (complete) transcript with a shorter rebuild.
            console.warn(
                "[Meeting Copilot][transcribe] rebuild incomplete; note left unchanged"
            );
            new Notice(t().notices.retranscribeIncomplete);
            if (!this.recorder.isRecording) this.clearActionStatus();
            return;
        }
        const combined = segments.join(TRANSCRIPT_SEGMENT_SEPARATOR);
        if (this.settings.insertTranscript) {
            await insertTranscript(this.app, note, combined, { append: false });
            new Notice(t().notices.transcriptAdded(note.basename));
            this.setActionStatus(t().statusBar.transcriptAdded, "success");
        } else if (!this.recorder.isRecording) {
            this.hideStatusBar();
        }
        this.agendaEvents.emit("changed", undefined);
        if (this.settings.enableEnrichment && this.settings.enrichOnTranscribe) {
            // The rebuild already ran through the queue; enqueue enrichment as its
            // own visible/cancellable task with the freshly combined transcript.
            void this.enqueueEnrichTask(note, { transcriptOverride: combined, quiet: true });
        }
    }

    /** A friendly name for a recording in the queue UI: its meeting note's title, else the file basename. */
    private transcribeLabelFor(recording: TFile): string {
        const note = findMeetingNoteForAudio(this.app, recording);
        if (note) return this.meetingNoteLabel(note);
        return recording.basename;
    }

    /** A meeting note's display label for the queue UI: its `title` frontmatter, else its basename. */
    private meetingNoteLabel(note: TFile): string {
        const fm = this.app.metadataCache.getFileCache(note)?.frontmatter as
            | Record<string, unknown>
            | undefined;
        const title = fm?.["title"];
        if (typeof title === "string" && title.trim()) return title.trim();
        return note.basename;
    }

    /** Reflects the queue's running/waiting state in the status bar (single-owner). */
    private renderQueueStatus(snapshot: QueueSnapshot): void {
        // Keep the hover popover live as the queue changes (or drop it when the
        // queue drains). The recording timer drives its own refresh, so only do
        // this on the non-recording path below.
        if (this.statusHovered) {
            if (snapshot.running || snapshot.waiting.length > 0)
                this.showQueuePopover(snapshot);
            else this.hideQueuePopover();
        }
        // The live recording timer owns the bar; and an idle queue leaves any
        // just-set terminal status (added / failed / cancelled) to settle on its
        // own rather than clearing it here. A running *enrich* owns the bar via
        // its own setEnrichStatus, so only the transcribe line is driven here.
        if (
            this.recorder.isRecording ||
            snapshot.running?.kind !== "transcribe"
        )
            return;
        // Preserve the live percentage across queue-change repaints: progress
        // ticks are sparse, so without this the bar would sit on a percent-less
        // label between them whenever a job is queued behind the running one.
        const running = snapshot.running;
        const pct =
            this.runningProgress?.id === running.id
                ? this.runningProgress.pct
                : null;
        this.setActionStatus(
            this.transcribeStatusText(running.label, pct, snapshot.waiting.length),
            "busy"
        );
    }

    /**
     * The status-bar line for a running transcription: percent-led when known
     * (`12% Name`), a plain `Name…` before the first tick, with a ` (+n queued)`
     * suffix when jobs wait behind it. Single source of truth for both the
     * progress ticks and the queue-change repaints so they never disagree.
     */
    private transcribeStatusText(
        label: string,
        pct: number | null,
        waiting: number
    ): string {
        const base =
            pct === null
                ? t().statusBar.transcribingNamed(label)
                : t().statusBar.transcribingNamedProgress(label, pct);
        return waiting > 0 ? base + t().statusBar.queuedSuffix(waiting) : base;
    }

    /**
     * Enter/leave the status bar (or the popover): reveal or defer-tear-down the
     * queue popover. Leaving schedules the hide on a short grace so the pointer
     * can cross into the interactive popover without it vanishing (and back).
     */
    private setStatusHover(hovering: boolean): void {
        if (hovering) {
            this.cancelPopoverHide();
            this.statusHovered = true;
            const snapshot = this.taskQueue.snapshot();
            if (snapshot.running || snapshot.waiting.length > 0)
                this.showQueuePopover(snapshot);
            return;
        }
        this.schedulePopoverHide();
    }

    /** Cancels a pending popover teardown (pointer re-entered the bar/popover). */
    private cancelPopoverHide(): void {
        if (this.popoverHideTimer !== null) {
            window.clearTimeout(this.popoverHideTimer);
            this.popoverHideTimer = null;
        }
    }

    /** Hides the popover after a short grace, so the bar↔popover hand-off survives. */
    private schedulePopoverHide(): void {
        this.cancelPopoverHide();
        this.popoverHideTimer = window.setTimeout(() => {
            this.popoverHideTimer = null;
            this.statusHovered = false;
            this.hideQueuePopover();
        }, 200);
    }

    /**
     * Shows (or refreshes) the roll-up panel above the status bar listing the
     * running task plus the next few waiting behind it. Each row carries a cancel
     * (x) control and the running transcription's live percentage (issue #96);
     * the panel is interactive, so a short hide grace bridges the bar↔popover gap.
     */
    private showQueuePopover(snapshot: QueueSnapshot): void {
        if (
            !this.statusBarEl ||
            (!snapshot.running && snapshot.waiting.length === 0)
        )
            return;
        if (!this.queuePopoverEl) {
            this.queuePopoverEl = document.body.createDiv({
                cls: "mc-queue-popover",
            });
            // Keep the panel alive while the pointer is over it (it's clickable),
            // and defer teardown when the pointer leaves.
            this.queuePopoverEl.addEventListener("mouseenter", () =>
                this.setStatusHover(true)
            );
            this.queuePopoverEl.addEventListener("mouseleave", () =>
                this.schedulePopoverHide()
            );
        }
        const el = this.queuePopoverEl;
        el.empty();
        el.createDiv({
            cls: "mc-queue-popover-title",
            text: t().statusBar.queuePopoverTitle,
        });
        const list = el.createDiv({ cls: "mc-queue-popover-list" });
        // `running` is momentarily null between tasks; still show the queue then.
        if (snapshot.running) {
            const pct =
                snapshot.running.kind === "transcribe" &&
                this.runningProgress?.id === snapshot.running.id
                    ? this.runningProgress.pct
                    : null;
            this.renderPopoverRow(list, snapshot.running, true, pct);
        }
        const limit = SystemRecordingPlugin.QUEUE_POPOVER_LIMIT;
        for (const item of snapshot.waiting.slice(0, limit)) {
            this.renderPopoverRow(list, item, false, null);
        }
        const extra = snapshot.waiting.length - limit;
        if (extra > 0) {
            el.createDiv({
                cls: "mc-queue-popover-more",
                text: t().statusBar.queueMore(extra),
            });
        }

        // Anchor the panel just above the status bar item, then clamp its left
        // so it can't spill off the right edge (the status bar sits far right,
        // and a short label like "Recording" would otherwise push it offscreen).
        // Measured after the content is in the DOM so offsetWidth is real.
        const rect = this.statusBarEl.getBoundingClientRect();
        const maxLeft = window.innerWidth - el.offsetWidth - 8;
        const left = Math.min(Math.max(8, rect.left), Math.max(8, maxLeft));
        el.style.left = `${left}px`;
        el.style.bottom = `${window.innerHeight - rect.top + 6}px`;
        window.requestAnimationFrame(() => el.addClass("is-visible"));
    }

    /**
     * Renders one popover row: a kind icon (spinner while running), the verb +
     * meeting label, the running transcription's percentage when known, and a
     * cancel (x) control wired to {@link TaskQueue.cancel} for this item.
     */
    private renderPopoverRow(
        list: HTMLElement,
        item: QueueItem,
        running: boolean,
        pct: number | null
    ): void {
        const row = list.createDiv({
            cls: running
                ? "mc-queue-popover-item is-running"
                : "mc-queue-popover-item",
        });
        setIcon(
            row.createSpan({ cls: "mc-queue-popover-icon" }),
            running ? "loader-2" : this.queueKindIcon(item.kind)
        );
        const verb =
            item.kind === "transcribe"
                ? t().statusBar.queueKindTranscribe
                : t().statusBar.queueKindEnrich;
        row.createSpan({
            cls: "mc-queue-popover-label",
            text: `${verb} · ${item.label}`,
        });
        if (pct !== null) {
            row.createSpan({
                cls: "mc-queue-popover-pct",
                text: `${pct}%`,
            });
        }
        const cancel = row.createEl("button", {
            cls: "mc-queue-popover-cancel",
            attr: { "aria-label": t().statusBar.queueCancel, type: "button" },
        });
        setIcon(cancel, "x");
        cancel.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            this.taskQueue.cancel(item.id);
        });
    }

    /** The lucide icon for a queued task kind (waiting rows; running rows spin a loader). */
    private queueKindIcon(kind: TaskKind): string {
        return kind === "enrich" ? "sparkles" : "clock";
    }

    /** Removes the queue hover popover and cancels any pending teardown. */
    private hideQueuePopover(): void {
        this.cancelPopoverHide();
        this.queuePopoverEl?.remove();
        this.queuePopoverEl = null;
    }

    /**
     * Cancels every queued/running *transcription* (command-palette action).
     * Enrichment tasks are left alone — cancel those individually from the
     * popover's per-item x. Cancelling a running transcribe transitively drops
     * any enrichment chained behind it (the queue's dependency handling).
     */
    private cancelActiveTranscription(): void {
        const snapshot = this.taskQueue.snapshot();
        const transcribeIds = [snapshot.running, ...snapshot.waiting]
            .filter((item): item is QueueItem => item?.kind === "transcribe")
            .map((item) => item.id);
        if (transcribeIds.length === 0) {
            new Notice(t().notices.nothingTranscribing);
            return;
        }
        for (const id of transcribeIds) this.taskQueue.cancel(id);
    }

    /**
     * On startup, count meeting notes that finished recording but were never
     * transcribed (status `recorded` + an existing linked recording) and nudge
     * the user — a plugin reload mid-transcription otherwise silently drops the
     * queued work with nothing prompting recovery.
     */
    private notifyPendingTranscriptions(): void {
        let pending = 0;
        for (const entry of scanMeetingNotes(this.app)) {
            if (entry.status !== "recorded") continue;
            const link = recordingLinkTarget(entry.recording);
            if (!link) continue;
            const dest = this.app.metadataCache.getFirstLinkpathDest(
                link,
                entry.file.path
            );
            if (dest instanceof TFile) pending++;
        }
        if (pending > 0) {
            new Notice(t().notices.recordingsPending(pending), 10000);
        }
    }

    /**
     * Enumerate input (microphone) devices via the recorder helper, for the
     * settings picker. Ensures the helper binary is present first (downloading
     * it unless `allowDownload` is false); returns [] when it can't be made
     * available or on any enumeration failure. macOS-only in practice.
     */
    async listInputDevices(opts?: {
        allowDownload?: boolean;
    }): Promise<InputDevice[]> {
        if (!Platform.isMacOS) return [];
        const binaryPath = resolveBinaryPath(this);
        if (opts?.allowDownload === false) {
            // Best-effort: only list if the helper is already launchable on disk
            // (binary AND its linked dylib), never trigger a download just to
            // populate the dropdown on open. Spawning the binary without the
            // dylib would fail in dyld, so require both.
            if (!fs.existsSync(binaryPath) || !fs.existsSync(resolveWhisperDylibPath(this))) {
                return [];
            }
        } else {
            try {
                await this.ensureHelperRuntime();
            } catch (e) {
                new Notice(e instanceof Error ? e.message : String(e));
                return [];
            }
        }
        return listInputDevices(binaryPath);
    }

    /**
     * Resolve the configured microphone to a device UID to record from, or
     * undefined for the system default. When a specific device is chosen but
     * isn't currently present (e.g. a Bluetooth mic that's off/unpaired), warn
     * with an auto-dismissing notice and fall back to the default so the
     * recording still starts. A failed enumeration (empty) isn't treated as
     * "gone": the selection is passed through and the helper falls back + warns
     * if the device really is missing.
     */
    private async resolveInputDeviceUid(
        binaryPath: string
    ): Promise<string | undefined> {
        const uid = this.settings.micDeviceUid;
        if (!uid) return undefined;
        // Short timeout: this runs on the critical path to starting a recording,
        // so a wedged helper must not stall the meeting. Enumeration is a quick
        // local CoreAudio query in practice.
        const devices = await listInputDevices(binaryPath, 2000);
        if (devices.length === 0) return uid;
        if (devices.some((d) => d.uid === uid)) return uid;
        const label = this.settings.micDeviceLabel || uid;
        new Notice(t().notices.micUnavailable(label), 6000);
        return undefined;
    }

    private openMeetingLink(url: string): void {
        if (url.startsWith("https://")) window.open(url, "_blank");
    }

    private async copyMeetingLink(url: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(url);
            new Notice(t().agenda.notices.linkCopied);
        } catch (e) {
            // Clipboard can be unavailable (permissions / non-secure context);
            // fall back to opening the link rather than failing silently.
            console.warn("[Meeting Copilot] clipboard write failed", e);
            this.openMeetingLink(url);
        }
    }

    private openPluginSettings(): void {
        const setting = (
            this.app as unknown as {
                setting?: {
                    open: () => void;
                    openTabById: (id: string) => void;
                };
            }
        ).setting;
        if (setting) {
            setting.open();
            setting.openTabById(this.manifest.id);
        }
    }

    // MARK: - Status handling

    private handleStatus(status: RecorderStatus) {
        if (status.status === "stopped") {
            if (status.file) {
                this.clearDurationTimer();
                this.updateRibbonIcon(false);
                this.hideStatusBar();

                const fileName = path.basename(status.file);
                // Meeting recordings are linked into their own note; ad-hoc ones
                // go to the active note as before.
                void this.attachRecording(fileName);
                new Notice(t().notices.recordingSaved);
            } else {
                // Stopped without a reported file (e.g. a clean helper exit with
                // no terminal payload); reset so the UI doesn't stay stuck.
                // Skip while a prior attach is still in flight — its finally owns
                // teardown and releasing back-to-back waiters (see onError).
                if (!this.attaching) this.resetRecordingUi();
            }
        } else if (status.status === "error") {
            // Don't tear down mid-attach (would early-release a back-to-back
            // waiter and race shared state); attachRecording's finally handles it.
            if (!this.attaching) this.resetRecordingUi();
            this.notifyRecordingError(status.message ?? t().notices.unknownError);
        } else if (status.status === "warning") {
            // Non-fatal: a capture path hit trouble (usually a device-change
            // restart that didn't take). Recording continues, but tell the user
            // so a silent stream isn't discovered only at stop. Coalesce so a
            // flapping device can't spam identical Notices.
            const msg = status.message;
            const now = Date.now();
            if (
                msg &&
                (msg !== this.lastWarningMessage ||
                    now - this.lastWarningAt > 30_000)
            ) {
                this.lastWarningMessage = msg;
                this.lastWarningAt = now;
                new Notice(msg);
            }
        }
    }

    /**
     * Shows a recording error. A "screen capture not authorized" failure is
     * common after a rename/update (macOS ties the Screen Recording grant to the
     * helper's identity/path), so surface clear, actionable instructions for it.
     */
    private notifyRecordingError(message: string): void {
        if (/screen[\s-]?(capture|recording)/i.test(message)) {
            new Notice(t().notices.screenPermission, 15000);
            // Take the user straight to the pane they need to toggle instead of
            // making them hunt through System Settings.
            this.openScreenRecordingSettings();
        } else {
            new Notice(t().notices.recordingError(message));
        }
    }

    /** Whether we've already opened the Screen Recording pane this session, so a retry loop doesn't reopen System Settings repeatedly. */
    private screenSettingsOpened = false;

    /**
     * Opens macOS System Settings directly at Privacy & Security → Screen
     * Recording so the user can grant Obsidian access. Best-effort and
     * macOS-only; opened at most once per session. macOS can't be made to grant
     * the permission programmatically (and won't re-show the initial prompt once
     * the grant is stale after a rename), so surfacing the exact pane is the
     * most we can automate.
     */
    private openScreenRecordingSettings(): void {
        if (!Platform.isMacOS || this.screenSettingsOpened) return;
        this.screenSettingsOpened = true;
        execFile(
            "open",
            [
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
            ],
            (err) => {
                if (err) console.warn("Failed to open Screen Recording settings", err);
            }
        );
    }

    // MARK: - UI helpers

    private startDurationTimer() {
        // Drop any leftover action-status spinner/styling before the timer owns the bar.
        this.clearActionStatus();
        if (this.statusBarEl) {
            this.statusBarEl.removeClass("system-recording-hidden");
            // Persistent structure: the timer text, plus a small badge that
            // appears only while background transcriptions are in flight. Kept
            // stable (updated in place) so the bar width doesn't jump.
            this.statusBarEl.empty();
            this.recTimeEl = this.statusBarEl.createSpan({ cls: "mc-rec-time" });
            this.recQueueEl = this.statusBarEl.createSpan({
                cls: "mc-rec-queue",
            });
        }
        this.lastDurationTickAt = Date.now();

        this.durationInterval = window.setInterval(() => {
            // A big real-time jump between 1 s ticks means the machine slept. If a
            // calendar recording's meeting is long over (its end + grace has
            // passed), the scheduler may have dropped the event while asleep, so
            // handle it here as a safety net rather than record indefinitely:
            // auto-stop when the user opted in, otherwise just offer to stop
            // (a recording never stops on its own without that opt-in).
            const now = Date.now();
            if (
                this.lastDurationTickAt !== null &&
                now - this.lastDurationTickAt > GRACE_MS &&
                this.currentRecordingEventEnd !== null &&
                now > this.currentRecordingEventEnd + GRACE_MS &&
                this.recorder.isRecording
            ) {
                this.lastDurationTickAt = now;
                const title =
                    this.currentMeetingNote?.basename ?? t().adhoc.defaultTitle;
                if (this.settings.calendarAutoStop) {
                    new Notice(t().event.autoStopped(title));
                    this.stopRecording();
                    return;
                }
                this.promptStopRecording(
                    t().event.ended(title),
                    t().event.stopRecordingPrompt
                );
                return;
            }
            this.lastDurationTickAt = now;

            if (!this.recordingStartTime || !this.statusBarEl) return;
            const elapsed = Math.floor(
                (now - this.recordingStartTime) / 1000
            );
            const h = String(Math.floor(elapsed / 3600)).padStart(2, "0");
            const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
            const s = String(elapsed % 60).padStart(2, "0");
            this.recTimeEl?.setText(t().statusBar.recording(`${h}:${m}:${s}`));

            // The timer always stays put; a small badge just notes how many
            // transcriptions are in flight so switching text never resizes the
            // bar. Count waiting even during the brief gap where one job has
            // finished and the next hasn't started (running momentarily null),
            // so the badge doesn't flicker to empty between jobs.
            const snapshot = this.taskQueue.snapshot();
            const count =
                snapshot.waiting.length + (snapshot.running ? 1 : 0);
            this.recQueueEl?.setText(
                count > 0 ? t().statusBar.transcribingCount(count) : ""
            );
            if (this.statusHovered && count > 0) {
                this.showQueuePopover(snapshot);
            }
        }, 1000);

        this.registerInterval(this.durationInterval);
    }

    private clearDurationTimer() {
        if (this.durationInterval !== null) {
            window.clearInterval(this.durationInterval);
            this.durationInterval = null;
        }
        this.lastDurationTickAt = null;
    }

    /** Returns all recording UI/state to idle after a stop or failure. */
    private resetRecordingUi() {
        this.clearDurationTimer();
        this.updateRibbonIcon(false);
        this.currentRecordingPath = null;
        this.hideStatusBar();
        this.currentMeetingNotePath = null;
        this.currentMeetingNote = null;
        this.currentRecordingEventId = null;
        this.currentRecordingEventEnd = null;
        // Recording has ended, so any "meeting ended — stop recording?" prompt is
        // moot; drop it.
        this.dismissStopPrompt();
        this.agendaEvents.emit("changed", undefined);
        // A stop that ends without going through attachRecording (no file, or an
        // error) must still release any back-to-back waiter.
        this.resolveStopWaiters();
    }

    /** Clears any action-status timeout, styling, and DOM (shared teardown). */
    private clearActionStatus() {
        if (this.statusTimeout !== null) {
            window.clearTimeout(this.statusTimeout);
            this.statusTimeout = null;
        }
        if (this.statusBarEl) {
            this.statusBarEl.removeClasses([
                "mc-status-busy",
                "mc-status-success",
                "mc-status-error",
            ]);
            this.statusBarEl.empty();
        }
        // The recording spans live inside the bar we just emptied.
        this.recTimeEl = null;
        this.recQueueEl = null;
    }

    private hideStatusBar() {
        this.clearActionStatus();
        // Hiding the bar (display:none) may not fire mouseleave, so drop the
        // hover flag ourselves — otherwise a later tick could re-open the
        // popover without the pointer actually being over the (re-shown) bar.
        this.statusHovered = false;
        this.hideQueuePopover();
        if (this.statusBarEl) {
            this.statusBarEl.addClass("system-recording-hidden");
        }
    }

    /** True while a *transcription* task is the running one (it owns the status bar's progress line). */
    private get transcriptionRunning(): boolean {
        return this.taskQueue.snapshot().running?.kind === "transcribe";
    }

    /**
     * Enrichment/title status writes yield the status bar to a running
     * transcription task. The queue runs one task at a time, so an enrichment is
     * only ever the running task when no transcription is — this keeps the bar
     * single-owner: a transcription's progress wins; enrichment shows its own
     * state otherwise.
     */
    private setEnrichStatus(
        text: string,
        state: "busy" | "success" | "error"
    ): void {
        if (this.transcriptionRunning) return;
        this.setActionStatus(text, state);
    }

    /**
     * Shows a transient action state (enriching, transcribing, …) in the status
     * bar. `state` "busy" shows a spinner; "success"/"error" auto-clear after a
     * few seconds. Skipped while recording, whose duration display owns the bar.
     */
    private setActionStatus(
        text: string,
        state: "busy" | "success" | "error"
    ): void {
        const el = this.statusBarEl;
        if (!el) return;
        // Don't clobber the live recording timer.
        if (this.recorder.isRecording) return;

        this.clearActionStatus();
        el.removeClass("system-recording-hidden");
        el.addClass(`mc-status-${state}`);

        const icon = el.createSpan({ cls: "mc-status-icon" });
        setIcon(
            icon,
            state === "busy"
                ? "loader-2"
                : state === "success"
                ? "check"
                : "alert-triangle"
        );
        el.createSpan({ cls: "mc-status-text", text });

        // Success/error clear quickly; a busy state clears on a long safety
        // timeout so a spinner can never get stuck if a completion event is missed.
        const clearAfter =
            state === "busy" ? 15 * 60 * 1000 : state === "error" ? 6000 : 4000;
        this.statusTimeout = window.setTimeout(() => {
            this.statusTimeout = null;
            if (!this.recorder.isRecording) this.hideStatusBar();
        }, clearAfter);
    }

    private updateRibbonIcon(recording: boolean) {
        if (this.ribbonIconEl) {
            if (recording) {
                this.ribbonIconEl.addClass("is-recording");
            } else {
                this.ribbonIconEl.removeClass("is-recording");
            }
        }
    }

    /**
     * True when the recorder's speech-window sidecar (split mode's
     * `<base>.speech.json`) reports any speech. Absent sidecar (mixed mode) →
     * false: there's no independent evidence, so the empty transcript is taken at
     * face value. Guards silent-discard against transcription misses, so it errs
     * toward KEEPING the audio whenever the evidence is uncertain: a sidecar that
     * exists but is unreadable/unparsable returns true (don't discard). Reads the
     * sidecar straight off disk via the adapter (not the vault index) so a
     * just-written speech.json isn't missed to index lag — which would strip the
     * very safety net right when it matters most (immediately after a stop).
     */
    private async recordingHasSpeech(recording: TFile): Promise<boolean> {
        const speechPath = sidecarPathsFor(recording.path).speech;
        let raw: string;
        try {
            if (!(await this.app.vault.adapter.exists(speechPath))) return false;
            raw = await this.app.vault.adapter.read(speechPath);
        } catch {
            // Present but unreadable → don't treat as silence.
            return true;
        }
        const windows = parseSpeechWindows(raw);
        // Present but unparsable → err toward keeping the audio.
        if (!windows) return true;
        return windows.me.length > 0 || windows.them.length > 0;
    }

    /**
     * Moves a vault file to the trash if it exists; never throws. Resolves via
     * the adapter (+ retry) rather than the vault index so a just-written file
     * the index hasn't caught up to (the .me/.them/.speech sidecars right after a
     * stop) is still found and removed instead of orphaned. Returns true when the
     * path is gone afterward (absent to begin with, or trashed), false only when
     * the file exists but trashing failed — so callers can avoid unlinking a
     * recording whose audio is still on disk.
     */
    private async trashIfExists(vaultPath: string): Promise<boolean> {
        // Check the disk directly (bypassing the vault index) so a genuinely
        // absent path returns fast and a just-written file is still found.
        if (!(await this.app.vault.adapter.exists(vaultPath))) return true;
        const f = await this.resolveFileWithRetry(vaultPath);
        if (!f) {
            // On disk but never resolved to a TFile (index lag exhausted): we
            // can't trash it via the file manager, and claiming success would
            // orphan it — report failure so the caller keeps the link.
            console.warn(
                `[Meeting Copilot] could not resolve ${vaultPath} to trash it`
            );
            return false;
        }
        try {
            await this.app.fileManager.trashFile(f);
            return true;
        } catch (e) {
            console.warn(`[Meeting Copilot] failed to trash ${vaultPath}`, e);
            return false;
        }
    }

    /**
     * Discards a just-stopped recording that came back silent (no speech in its
     * transcript): trashes the audio + its split sidecars and removes the
     * recording's link from its owning meeting note, so the meeting immediately
     * re-offers "record". When that was the note's only recording and no
     * transcript was ever saved, the note falls back to "scheduled" so it
     * doesn't read as recorded. The owning note is resolved *before* trashing
     * (the link resolves only while the file still exists). Best-effort.
     */
    private async discardSilentRecording(recording: TFile): Promise<void> {
        const note = findMeetingNoteForAudio(this.app, recording);
        const prunedPath = recording.path;
        const sc = sidecarPathsFor(recording.path);
        // Trash the audio first; only unlink it from the note once it's actually
        // gone. Unlinking a still-present recording would orphan it — on disk but
        // owned by no note, so the retention sweep would never reclaim it.
        if (!(await this.trashIfExists(recording.path))) {
            console.warn(
                `[Meeting Copilot][recorder] could not discard silent recording "${recording.name}" (trash failed); left linked`
            );
            return;
        }
        await this.trashIfExists(sc.me);
        await this.trashIfExists(sc.them);
        await this.trashIfExists(sc.speech);
        if (note) {
            await this.app.fileManager.processFrontMatter(note, (fm) => {
                const f = fm as Record<string, unknown>;
                const next = dropRecordingLink(f.recording, prunedPath);
                const hasTranscript = f.transcript_saved === true;
                if (next === undefined) {
                    // No recordings left: back to "scheduled" unless an earlier
                    // transcript is still in the note (then it's "transcribed").
                    delete f.recording;
                    f.status = hasTranscript ? "transcribed" : "scheduled";
                } else {
                    // Other take(s) remain — `linkRecording` had regressed status
                    // to "recorded" for this now-discarded take; reflect whether
                    // the survivors are already transcribed.
                    f.recording = next;
                    f.status = hasTranscript ? "transcribed" : "recorded";
                }
            });
        }
        console.warn(
            `[Meeting Copilot][recorder] discarded silent recording "${recording.name}"`
        );
        new Notice(t().notices.silentDiscarded);
        this.agendaEvents.emit("changed", undefined);
    }

    /**
     * Inserts a finished transcription into its meeting note and refreshes the
     * agenda. Returns the owning note (when found) and the fresh transcript, so
     * the caller can enrich *after* the transcription queue slot is released
     * (enrichment no longer runs from inside this method — see launchTranscriber).
     */
    private async handleTranscriptionCompleted(
        payload: unknown,
        append = false
    ): Promise<{ note: TFile | null; transcript: string | null }> {
        let enrichTarget: TFile | null = null;
        let transcriptText: string | null = null;
        let inserted = false;
        try {
            const p = (payload ?? {}) as {
                audioFile?: unknown;
                transcription?: unknown;
                file?: unknown;
            };
            const audio = p.audioFile;
            const raw =
                typeof p.transcription === "string" ? p.transcription : null;
            const transcript = raw && raw.trim().length > 0 ? raw : null;
            if (audio instanceof TFile && transcript) {
                transcriptText = transcript;
                const note = findMeetingNoteForAudio(this.app, audio);
                console.warn(
                    `[Meeting Copilot][transcribe] note match for "${audio.name}": ${
                        note ? note.path : "none"
                    } (insertTranscript=${this.settings.insertTranscript})`
                );
                // Skip if the transcriber already wrote into the meeting note.
                const already =
                    p.file instanceof TFile &&
                    note !== null &&
                    p.file.path === note.path;
                if (note) {
                    // Record the note first so a failed insert still reports
                    // "note found" (not the misleading "no meeting note" notice).
                    enrichTarget = note;
                    if (this.settings.insertTranscript && !already) {
                        await insertTranscript(this.app, note, transcript, {
                            append,
                        });
                        new Notice(t().notices.transcriptAdded(note.basename));
                        inserted = true;
                        // Hand the caller the FULL callout (all takes) to enrich,
                        // not just this take — otherwise a second take's summary
                        // would ignore the first. On the replace path this equals
                        // the take just written; on append it's the combined
                        // chronological transcript.
                        const combined = extractTranscript(
                            await this.app.vault.read(note)
                        );
                        if (combined.trim().length > 0) transcriptText = combined;
                    }
                }
            }
        } catch (e) {
            console.warn("Meeting Copilot: failed to insert transcript", e);
        }
        this.agendaEvents.emit("changed", undefined);

        // Resolve the "Transcribing…" spinner deterministically here, before
        // enrichment runs: success only if we actually inserted, otherwise
        // clear it (never touching the recording timer). Enrichment then manages
        // its own status when it proceeds, and if it bails early the transcription
        // status is already settled, so the spinner can't linger.
        if (inserted) {
            this.setActionStatus(t().statusBar.transcriptAdded, "success");
        } else if (!this.recorder.isRecording) {
            this.hideStatusBar();
        }
        return { note: enrichTarget, transcript: transcriptText };
    }

    /** Enriches the active markdown note, if it is one. */
    private async enrichActiveNote(): Promise<void> {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md") {
            new Notice(t().notices.notAMeetingNote);
            return;
        }
        await this.enqueueEnrich(file);
    }

    /** The task-queue id for enriching a note; namespaced so it can't collide with a recording path. */
    private enrichTaskId(notePath: string): string {
        return `enrich:${notePath}`;
    }

    /**
     * The single entry point for "enrich this note" (issue #96). Validates the
     * enrichment config, and — when the note has no transcript yet but owns a
     * recording — transcribes first via {@link launchTranscriber} (which chains
     * the enrichment as a dependent queue task). Otherwise it enqueues the
     * enrichment directly. "Enrich" thus means "produce the enrichment", pulling
     * transcription in automatically when needed; it only reports "nothing to
     * enrich" when there's neither transcript/notes nor a recording to work from.
     */
    private async enqueueEnrich(file: TFile): Promise<void> {
        if (!this.settings.enableEnrichment) {
            new Notice(t().notices.enrichDisabled);
            return;
        }
        const { apiBaseUrl, apiKey, enrichModel } = this.settings;
        if (!apiBaseUrl || !apiKey || !enrichModel) {
            new Notice(t().notices.enrichNotConfigured);
            return;
        }
        // No transcript yet but a recording exists → transcribe first, then
        // enrich as a dependent task once it lands.
        const existing = extractTranscript(await this.app.vault.read(file));
        if (!existing.trim()) {
            const recording = this.agendaMeetingFromNote(file).recording;
            if (recording) {
                if (this.taskQueue.has(recording.path)) {
                    // That recording is already transcribing (auto-transcribe or
                    // a manual run): don't kick a second one — just chain the
                    // enrichment behind it so the user's click isn't dropped.
                    void this.enqueueEnrichTask(file, {
                        dependsOn: recording.path,
                    });
                } else {
                    // launchTranscriber enqueues the dependent enrichment itself.
                    await this.launchTranscriber(recording, "auto", {
                        enrichAfter: true,
                    });
                }
                return;
            }
        }
        // A transcript exists (or there's no recording, but there may still be
        // manual notes / action items worth enriching) — enqueue it. The worker
        // surfaces "nothing to enrich" if the note is truly empty.
        void this.enqueueEnrichTask(file, {});
    }

    /**
     * Enqueues an enrichment task on the shared queue: visible in the popover,
     * per-item cancellable, and (optionally) gated behind a transcription via
     * `dependsOn`. Deduped by the note's enrich id, so a double-trigger runs
     * once. `resolveTranscript` is read when the task starts (the pipeline uses
     * it to hand over the transcript the transcription just produced); `quiet`
     * suppresses the "nothing to enrich" notice for automatic runs.
     */
    private enqueueEnrichTask(
        note: TFile,
        opts: {
            dependsOn?: string;
            transcriptOverride?: string;
            resolveTranscript?: () => string | undefined;
            quiet?: boolean;
        }
    ): Promise<void> {
        const id = this.enrichTaskId(note.path);
        // A manual re-trigger while an enrich for this note is already queued or
        // running: say so (a dependent pipeline task never shows this).
        if (opts.dependsOn === undefined && this.taskQueue.has(id)) {
            new Notice(t().notices.enrichInProgress);
        }
        const promise = this.taskQueue.enqueue({
            id,
            label: this.meetingNoteLabel(note),
            kind: "enrich",
            dependsOn: opts.dependsOn,
            run: async (signal) => {
                const transcript =
                    opts.transcriptOverride ?? opts.resolveTranscript?.();
                await this.runEnrich(note, transcript, signal, opts.quiet ?? false);
            },
        });
        // Cancellation is expected/quiet; log only unexpected failures (runEnrich
        // surfaces its own error notice, so this is a last-resort net).
        promise.catch((e) => {
            if (!(e instanceof TaskCancelledError)) {
                console.warn("[Meeting Copilot] enrichment failed", e);
            }
        });
        return promise;
    }

    /**
     * Generates AI notes from the note's manual notes + transcript and inserts a
     * gray callout — the worker run by an enrichment queue task. Honors `signal`
     * (a cancel rejects promptly and skips the write) and, when `quiet`, stays
     * silent if there's nothing to enrich (an automatic pipeline run).
     */
    private async runEnrich(
        file: TFile,
        transcriptOverride: string | undefined,
        signal: AbortSignal,
        quiet: boolean
    ): Promise<void> {
        const { apiBaseUrl, apiKey, enrichModel } = this.settings;
        // Config can change between enqueue and run; re-check and bail quietly.
        if (
            !this.settings.enableEnrichment ||
            !apiBaseUrl ||
            !apiKey ||
            !enrichModel
        ) {
            return;
        }
        let enrichedOk = false;
        // Captured inside the try once frontmatter is read; used after a successful
        // enrich so we don't re-query a lagging metadataCache for the title gate.
        let eventIdForTitle: unknown;
        let alreadySuggestedForTitle: unknown;
        /** Title embedded in the enrich response (same LLM call); offered after write. */
        let embeddedTitle: string | null = null;
        try {
            const content = await this.app.vault.read(file);
            // Gather manual notes wherever they were written (incl. above the
            // "## Notes" heading), not just the section body.
            const notes = normalizeManualNotes(content).notes;
            // The participant's own, hand-written action items. Feeding them to
            // the model lets it produce ONE unified list that honors/improves
            // each one, so the drop-and-replace merge below can't silently lose
            // an item the model would otherwise never have re-derived.
            const manualActionItems = extractManualActionItems(
                extractSection(content, ACTION_ITEMS_HEADING)
            ).map(stripTaskMeta);
            const manualFollowUps = extractManualActionItems(
                extractSection(content, FOLLOW_UPS_HEADING)
            ).map(stripTaskMeta);
            const transcript =
                transcriptOverride && transcriptOverride.trim().length > 0
                    ? transcriptOverride
                    : extractTranscript(content);
            // Hand-written action items / follow-ups are enrichment input too,
            // so a note that only has those lists (no notes/transcript) is
            // still worth enriching — the model can tidy/unify those items.
            if (
                !notes &&
                !transcript &&
                manualActionItems.length === 0 &&
                manualFollowUps.length === 0
            ) {
                if (!quiet) new Notice(t().notices.nothingToEnrich);
                return;
            }

            const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ??
                {}) as Record<string, unknown>;
            // Capture identity flags *before* we write — a post-write metadataCache
            // lookup can lag and skip the ad-hoc title offer (issue #110).
            eventIdForTitle = fm["event_id"];
            alreadySuggestedForTitle = fm["mc_title_suggested"];
            const wantTitle = shouldSuggestAdhocTitle({
                suggestAdhocTitle: this.settings.suggestAdhocTitle,
                eventId: eventIdForTitle,
                alreadySuggested: alreadySuggestedForTitle,
            });
            const attendeesVal = fm["attendees"];
            const titleVal = fm["title"];
            const dateVal = fm["date"];
            const ctx = {
                title: typeof titleVal === "string" ? titleVal : file.basename,
                date: typeof dateVal === "string" ? dateVal : "",
                attendees: Array.isArray(attendeesVal)
                    ? attendeesVal.map((x) => String(x)).join(", ")
                    : "",
                notes,
                actionItems: manualActionItems.map((i) => `- ${i}`).join("\n"),
                followUps: manualFollowUps.map((i) => `- ${i}`).join("\n"),
                transcript,
            };

            new Notice(t().notices.enriching);
            this.setEnrichStatus(t().statusBar.enriching, "busy");
            // Ask for an ad-hoc title in the *same* enrich call (trailer parsed
            // below) — no second LLM round-trip over the transcript.
            const userPrompt =
                fillPrompt(
                    effectiveEnrichPrompt(
                        this.settings.enrichPromptCustomize,
                        this.settings.enrichPrompt
                    ),
                    ctx
                ) + (wantTitle ? ADHOC_TITLE_PROMPT_SUFFIX : "");
            const rawOutput = await chatComplete({
                baseUrl: apiBaseUrl,
                apiKey: apiKey,
                model: enrichModel,
                system: ENRICH_SYSTEM_PROMPT,
                user: userPrompt,
                signal,
            });
            // Only parse/strip a title trailer when we asked for one — calendar
            // enrichments must never feed RenameModal (scheduled titles stay).
            const extracted = wantTitle
                ? extractEmbeddedTitle(rawOutput)
                : { body: rawOutput, title: null };
            const output = extracted.body;
            if (wantTitle) {
                const cleaned = extracted.title
                    ? cleanSuggestedTitle(extracted.title)
                    : "";
                // sanitizeName maps blank → "Untitled"; don't offer that.
                if (cleaned && cleaned !== "Untitled") {
                    embeddedTitle = cleaned;
                } else {
                    console.warn(
                        "[Meeting Copilot] title suggestion skipped: enrich response missing title trailer",
                        file.path
                    );
                }
            }
            // Re-read in case the note changed during the network call.
            const current = await this.app.vault.read(file);
            // The transcript callout has no heading of its own, so it lives
            // inside whatever section precedes it (usually "## Follow-ups" or
            // "## Action items"). Pull it out before any section edits —
            // otherwise extractSection would scoop it up and merged items
            // would land *after* it — and re-pin it to the very bottom once
            // everything else is placed.
            const bottomTranscript = extractTranscript(current);
            let updated = bottomTranscript.trim().length
                ? stripTranscript(current)
                : current;
            // Consolidate any loose notes under "## Notes" (creating it if
            // missing) so they're preserved in place rather than orphaned.
            updated = normalizeManualNotes(updated).content;
            let calloutBody = output;
            // Lift Next steps / Follow-ups out of the summary into real
            // obsidian-tasks checkboxes under the matching ## sections
            // (merged, never duplicated). Stamp fresh items with ➕ today.
            if (this.settings.actionItemsAsTasks) {
                const created = this.todayStamp();
                const actions = extractActionItems(calloutBody);
                calloutBody = actions.without;
                const followUps = extractFollowUps(calloutBody);
                calloutBody = followUps.without;
                if (actions.items.length > 0) {
                    const existing = extractSection(
                        updated,
                        ACTION_ITEMS_HEADING
                    );
                    // Merge first (carries prior ➕ onto normalized matches),
                    // then stamp only lines still missing a creation date.
                    const merged = stampCreatedDate(
                        refreshActionItems(existing, actions.items).split("\n"),
                        created
                    ).join("\n");
                    updated = upsertSection(
                        updated,
                        ACTION_ITEMS_HEADING,
                        merged
                    );
                }
                if (followUps.items.length > 0) {
                    const existing = extractSection(
                        updated,
                        FOLLOW_UPS_HEADING
                    );
                    const merged = stampCreatedDate(
                        refreshActionItems(existing, followUps.items).split(
                            "\n"
                        ),
                        created
                    ).join("\n");
                    updated = upsertSection(
                        updated,
                        FOLLOW_UPS_HEADING,
                        merged
                    );
                }
            }
            updated = withEnrichedBlock(updated, calloutBody);
            // Keep the transcript pinned to the very bottom of the note.
            if (bottomTranscript.trim().length) {
                updated = transcriptAtBottom(updated, bottomTranscript);
            }
            await this.app.vault.modify(file, updated);
            await this.app.fileManager.processFrontMatter(file, (f) => {
                (f as Record<string, unknown>).status = "enriched";
            });
            new Notice(t().notices.enrichDone(file.basename));
            this.setEnrichStatus(t().statusBar.enriched, "success");
            this.agendaEvents.emit("changed", undefined);
            enrichedOk = true;
        } catch (e) {
            // A cancel (via signal) is expected: stay quiet and rethrow as the
            // queue's cancellation type so it rejects (and drops any dependents)
            // rather than logging a failure or writing a partial note.
            if (this.isEnrichCancelled(e, signal)) {
                if (!this.transcriptionRunning) this.clearActionStatus();
                throw new TaskCancelledError();
            }
            new Notice(
                t().notices.enrichError(e instanceof Error ? e.message : String(e))
            );
            this.setEnrichStatus(t().statusBar.enrichFailed, "error");
            // Reject the queue task (its own catch just logs) so a failed enrich
            // isn't recorded as a success — and skips the title-suggestion step.
            throw e;
        }

        // After the AI summary, offer the title that came back in the same enrich
        // response (once). Only ad-hoc notes request a trailer / reach here with
        // a title; scheduled meetings keep their calendar title.
        if (
            enrichedOk &&
            embeddedTitle &&
            shouldSuggestAdhocTitle({
                suggestAdhocTitle: this.settings.suggestAdhocTitle,
                eventId: eventIdForTitle,
                alreadySuggested: alreadySuggestedForTitle,
            })
        ) {
            await this.offerAdhocTitle(file, embeddedTitle);
        }
    }

    /** Whether an error from an enrichment LLM call is a user cancellation (queue abort). */
    private isEnrichCancelled(error: unknown, signal: AbortSignal): boolean {
        return signal.aborted || error instanceof ChatAbortError;
    }

    /**
     * Offers to rename an ad-hoc note to a title already produced by enrich.
     * No LLM call — the title was embedded in the enrich response.
     */
    private async offerAdhocTitle(file: TFile, title: string): Promise<void> {
        if (this.titleSuggestingPaths.has(file.path)) {
            console.warn(
                "[Meeting Copilot] title suggestion skipped: already in flight",
                file.path
            );
            return;
        }
        this.titleSuggestingPaths.add(file.path);
        try {
            const prefix = this.datePrefixOf(file);
            const suggested = prefix ? `${prefix} ${title}` : title;
            // Mark settled only when the modal closes (Rename / Keep / dismiss),
            // so Esc-without-action can still re-offer on a later enrich.
            new RenameModal(this.app, {
                heading: t().adhoc.titleModal.heading,
                desc: t().adhoc.titleModal.desc,
                value: suggested,
                renameLabel: t().adhoc.titleModal.rename,
                keepLabel: t().adhoc.titleModal.keep,
                onRename: (value) => {
                    void this.renameMeetingNote(file, value, prefix);
                },
                onDecide: () => {
                    void this.app.fileManager.processFrontMatter(file, (f) => {
                        (f as Record<string, unknown>).mc_title_suggested = true;
                    });
                },
            }).open();
        } catch (e) {
            console.warn("[Meeting Copilot] title suggestion failed", e);
        } finally {
            this.titleSuggestingPaths.delete(file.path);
        }
    }

    /** The leading `YYYY-MM-DD [HHmm]` portion of a note's basename, or from frontmatter. */
    private datePrefixOf(file: TFile): string {
        const m = file.basename.match(/^(\d{4}-\d{2}-\d{2}(?:\s+\d{3,4})?)/);
        if (m?.[1]) return m[1];
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
            | Record<string, unknown>
            | undefined;
        // Prefer `start` (YYYY-MM-DDTHH:MM:SS) so we keep the time component.
        const start = fm?.["start"];
        if (typeof start === "string") {
            const sm = start.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
            if (sm) return `${sm[1]} ${sm[2]}${sm[3]}`;
        }
        const date = fm?.["date"];
        return typeof date === "string" ? date : "";
    }

    /**
     * Renames the note file and syncs the H1 + frontmatter title. The new name
     * is expected to already include the date prefix; `titlePrefix` is stripped
     * to derive the human title for the H1/frontmatter.
     */
    private async renameMeetingNote(
        file: TFile,
        newBasename: string,
        titlePrefix: string
    ): Promise<void> {
        try {
            const safeBase = sanitizeName(newBasename);
            const folder = folderOf(file);
            const pathFor = (base: string): string =>
                normalizePath(folder ? `${folder}/${base}.md` : `${base}.md`);
            // Avoid clobbering an existing note (try " 2", " 3", …).
            let target = pathFor(safeBase);
            for (
                let n = 2;
                target !== file.path &&
                this.app.vault.getAbstractFileByPath(target) &&
                n < 1000;
                n++
            ) {
                target = pathFor(`${safeBase} ${n}`);
            }
            const humanTitle =
                titlePrefix && safeBase.startsWith(titlePrefix)
                    ? safeBase.slice(titlePrefix.length).trim() || safeBase
                    : safeBase;

            if (target !== file.path) {
                await this.app.fileManager.renameFile(file, target);
            }
            const content = await this.app.vault.read(file);
            const updated = content.replace(/^#\s+.*$/m, `# ${humanTitle}`);
            if (updated !== content) await this.app.vault.modify(file, updated);
            await this.app.fileManager.processFrontMatter(file, (f) => {
                (f as Record<string, unknown>).title = humanTitle;
            });
            new Notice(t().adhoc.titleModal.renamed(humanTitle));
            this.agendaEvents.emit("changed", undefined);
        } catch (e) {
            new Notice(
                t().notices.recordingError(
                    e instanceof Error ? e.message : String(e)
                )
            );
        }
    }

    /**
     * Moves recordings older than `retentionDays` to the trash so they don't
     * grow forever. Only touches audio under the meetings/recordings folders,
     * and only when the owning meeting note actually contains the transcript —
     * so the audio is never the last copy of the content. Orphan/inline audio
     * and not-yet-transcribed notes are left untouched. `retentionDays: 0`
     * disables cleanup entirely.
     */
    private async cleanupOldRecordings(notify: boolean): Promise<number> {
        if (this.settings.retentionDays <= 0) {
            if (notify) new Notice(t().notices.retentionDisabled);
            return 0;
        }
        if (this.cleanupRunning) return 0;
        this.cleanupRunning = true;
        try {
            const files = this.app.vault.getFiles().map((f) => ({
                path: f.path,
                ext: f.extension,
                mtime: f.stat.mtime,
            }));
            // Scope retention to the configured roots plus the recordings
            // folder, and additionally the exact audio files linked from
            // plugin-owned notes (so a recording colocated with a series/1:1
            // folder that moved elsewhere is still covered). Exact paths, not
            // the notes' parent folders: sweeping a moved note's folder would
            // make every old audio file in that unrelated subtree eligible.
            const ownedRecordings = new Set<string>();
            for (const entry of scanMeetingNotes(this.app)) {
                if (!entry.eventId) continue;
                // A meeting can link more than one recording; own them all so a
                // second take is swept on the same rule as the first.
                for (const link of recordingLinkTargets(entry.recording)) {
                    const dest = this.app.metadataCache.getFirstLinkpathDest(
                        link,
                        entry.file.path
                    );
                    if (dest instanceof TFile) ownedRecordings.add(dest.path);
                }
            }
            const folders = [...new Set(this.configuredMeetingRoots())].filter(
                (f) => f.length > 0
            );
            const expired = findExpiredRecordings(files, {
                folders,
                extraPaths: ownedRecordings,
                retentionDays: this.settings.retentionDays,
                now: Date.now(),
                protectedPaths: this.currentRecordingPath
                    ? new Set([this.currentRecordingPath])
                    : undefined,
            });

            let removed = 0;
            const trash = async (p: string): Promise<boolean> => {
                const f = this.app.vault.getAbstractFileByPath(p);
                if (!(f instanceof TFile)) return false;
                try {
                    await this.app.fileManager.trashFile(f);
                    return true;
                } catch (e) {
                    console.warn(`[Meeting Copilot] failed to trash ${p}`, e);
                    return false;
                }
            };
            // Pass 1: primary recordings. The split sidecars (`.me`/`.them`/
            // `.speech.json`) have no owning note of their own, so they never
            // pass the note gate on their own — prune them together with the
            // primary recording they belong to instead (otherwise they'd leak
            // forever once the primary is gone).
            for (const info of expired) {
                if (isSidecarPath(info.path)) continue;
                const file = this.app.vault.getAbstractFileByPath(info.path);
                if (!(file instanceof TFile)) continue;
                // Resolve the meeting note that owns THIS audio — colocated
                // (same folder + basename) or linked via `recording` frontmatter.
                const note = findMeetingNoteForAudio(this.app, file);
                // Only prune when the plugin has durably saved the transcript
                // into the owning note. Skip when there's no owning note
                // (orphan/inline-embedded ad-hoc recordings, or unrelated user
                // audio) or the transcript was never captured — deleting those
                // would destroy the only copy.
                if (!note || !this.noteHasSavedTranscript(note)) continue;
                // A note carrying more than one recording keeps `transcript_saved`
                // from an earlier take even while a newer take is still pending
                // transcription (status "recorded"). Pruning then could delete
                // the newer, not-yet-captured audio — so hold off on the whole
                // note until its latest take has been transcribed.
                if (this.noteHasPendingRecording(note)) continue;
                if (await trash(info.path)) {
                    removed++;
                    // Trash the split sidecars alongside the primary recording.
                    const sc = sidecarPathsFor(info.path);
                    await trash(sc.me);
                    await trash(sc.them);
                    await trash(sc.speech);
                    // Drop just this recording's now-dangling link (a meeting
                    // may have several); the transcript stays in the note. Only
                    // stamp `recording_pruned` once the last one is gone.
                    await this.app.fileManager.processFrontMatter(note, (fm) => {
                        const f = fm as Record<string, unknown>;
                        const next = dropRecordingLink(f.recording, info.path);
                        if (next === undefined) {
                            delete f.recording;
                            f.recording_pruned = new Date()
                                .toISOString()
                                .slice(0, 10);
                        } else {
                            f.recording = next;
                        }
                    });
                }
            }
            // Pass 2: sweep expired sidecars whose primary recording is already
            // gone (orphans — e.g. from an older build that pruned the primary
            // but left the sidecars). Sidecars still sitting next to a live
            // primary are left alone; pass 1 owns those.
            for (const info of expired) {
                const candidates = baseRecordingCandidatesOf(info.path);
                if (candidates.length === 0) continue;
                const primaryAlive = candidates.some(
                    (base) =>
                        this.app.vault.getAbstractFileByPath(base) instanceof
                        TFile
                );
                if (primaryAlive) continue;
                // A primary recording whose own basename happens to end in
                // `.me`/`.them` matches the sidecar naming, so it lands here
                // instead of pass 1's transcript-saved gate. Never sweep a
                // file a meeting note claims as its recording.
                const file = this.app.vault.getAbstractFileByPath(info.path);
                if (
                    file instanceof TFile &&
                    findMeetingNoteForAudio(this.app, file)
                ) {
                    continue;
                }
                if (await trash(info.path)) removed++;
            }

            if (removed > 0) {
                new Notice(t().notices.retentionCleaned(removed));
                this.agendaEvents.emit("changed", undefined);
            } else if (notify) {
                new Notice(t().notices.retentionNothing);
            }
            return removed;
        } finally {
            this.cleanupRunning = false;
        }
    }

    /**
     * True only when this plugin has durably written the transcript into the
     * note — the `transcript_saved` flag stamped by `insertTranscript`.
     * Retention keys on this managed flag rather than sniffing the body: a
     * customized note template can carry a `## Transcript`/callout placeholder
     * that looks like a real transcript, and trusting that would trash the only
     * copy of the audio (issue #46). With "Insert transcript" off the flag is
     * never set, so that note's audio is kept. Legacy notes transcribed before
     * this flag existed also lack it, so their audio is kept (safe) rather than
     * pruned. Reads frontmatter from the metadata cache; if it's unavailable we
     * treat the transcript as unsaved and keep the audio.
     */
    private noteHasSavedTranscript(note: TFile): boolean {
        const fm = this.app.metadataCache.getFileCache(note)?.frontmatter;
        return fm?.transcript_saved === true;
    }

    /**
     * True when the note has a recording awaiting transcription — its `status`
     * is "recorded" (the state `linkRecording` stamps on every stop, cleared to
     * "transcribed" by `insertTranscript`). Used to hold retention off a
     * multi-take note whose newest take isn't captured yet, even though an
     * earlier take already set `transcript_saved`.
     */
    private noteHasPendingRecording(note: TFile): boolean {
        const fm = this.app.metadataCache.getFileCache(note)?.frontmatter;
        return fm?.status === "recorded";
    }

    /**
     * Creates or refreshes the plugin-rendered meetings dashboard note. Only the
     * plugin-managed block between markers is rewritten, so user edits around it
     * survive re-runs.
     */
    private async createDashboard(): Promise<void> {
        // Only decides where the dashboard *note* lives; the rendered block
        // itself is vault-wide (see buildDashboardBlock).
        const folder = templateStaticRoot(this.settings.oneOffFolderTemplate) || "Meetings";
        if (!(await this.app.vault.adapter.exists(folder))) {
            await this.app.vault
                .createFolder(folder)
                .catch(() => {
                    /* created concurrently */
                });
        }
        const path = normalizePath(`${folder}/Meetings Dashboard.md`);
        const block = buildDashboardBlock();
        const existing = this.app.vault.getAbstractFileByPath(path);
        let file: TFile;
        if (existing instanceof TFile) {
            const content = await this.app.vault.read(existing);
            await this.app.vault.modify(existing, withDashboardBlock(content, block));
            file = existing;
        } else {
            file = await this.app.vault.create(path, `${block}\n`);
        }
        // Tag the note so it can use the full editor width (readable line length
        // off) and render its tables densely — see styles.css. Merges into any
        // existing `cssclasses` rather than clobbering the user's.
        await this.app.fileManager.processFrontMatter(file, (fm) => {
            const raw = (fm as Record<string, unknown>).cssclasses;
            const list = Array.isArray(raw)
                ? raw.filter((c): c is string => typeof c === "string")
                : typeof raw === "string" && raw
                  ? [raw]
                  : [];
            if (!list.includes(DASHBOARD_CSS_CLASS)) list.push(DASHBOARD_CSS_CLASS);
            (fm as Record<string, unknown>).cssclasses = list;
        });
        await this.app.workspace.getLeaf(false).openFile(file);
        new Notice(t().notices.dashboardCreated);
    }

    /** Flips the vault-wide "hide AI notes" toggle and persists it. */
    private async toggleAiNotes(): Promise<void> {
        this.settings.hideAiNotes = !this.settings.hideAiNotes;
        document.body.toggleClass(HIDE_AI_CLASS, this.settings.hideAiNotes);
        await this.saveSettings();
        new Notice(
            this.settings.hideAiNotes
                ? t().notices.aiNotesHidden
                : t().notices.aiNotesShown
        );
    }

    private async attachRecording(fileName: string) {
        this.attaching = true;
        // Prefer the live TFile (survives a rename during recording); fall back
        // to the path captured at start.
        const noteRef = this.currentMeetingNote;
        const notePath = noteRef?.path ?? this.currentMeetingNotePath;
        // Captured before the block below nulls it: the recorder wrote the WAV
        // to wherever recording *started*, which is no longer the note's folder
        // if the note was moved mid-recording. Deriving the link from the
        // note's current path in that case would point at a path the file was
        // never written to, breaking auto-transcribe.
        const recordingPath = this.currentRecordingPath;
        this.currentMeetingNotePath = null;
        this.currentMeetingNote = null;
        this.currentRecordingEventId = null;
        this.currentRecordingEventEnd = null;
        this.currentRecordingPath = null;
        this.agendaEvents.emit("changed", undefined);
        try {
        if (notePath) {
            const file =
                noteRef ?? this.app.vault.getAbstractFileByPath(notePath);
            if (file instanceof TFile) {
                // Qualify the link with the folder the recording actually lives
                // in (see `recordingPath` above), so duplicate basenames
                // elsewhere can't resolve to the wrong file.
                const dirOf = (p: string): string => {
                    const slash = p.lastIndexOf("/");
                    return slash >= 0 ? p.slice(0, slash) : "";
                };
                const folder = dirOf(recordingPath ?? notePath);
                // Normalize so this key matches the recording's TFile.path (which
                // uniqueRecordingPath already normalized) — the pendingAutoTranscribe
                // lookup and the index poll both key on it.
                const link = normalizePath(
                    folder ? `${folder}/${fileName}` : fileName
                );
                try {
                    await linkRecording(this.app, file, link);
                } catch (e) {
                    new Notice(
                        t().notices.recordingError(
                            e instanceof Error ? e.message : String(e)
                        )
                    );
                } finally {
                    this.agendaEvents.emit("changed", undefined);
                }
                // Close the loop: hand the fresh recording to the transcriber.
                if (this.settings.autoTranscribe) {
                    // The helper writes the recording from a separate process, so
                    // Obsidian's index may not have registered it as a TFile yet.
                    // Wait for it to appear — event-driven with a generous cap, so
                    // a slow watcher (cloud-synced vault, App Nap while the app is
                    // backgrounded during the meeting) no longer silently drops
                    // the headline automation (issue #29). Cancellable so a manual
                    // transcribe of the same take supersedes it.
                    const ac = new AbortController();
                    // Supersede any stale wait for this path (implausible with
                    // unique names, but keeps the map single-writer per path).
                    this.cancelPendingAutoTranscribe(link);
                    this.pendingAutoTranscribe.set(link, ac);
                    void this.resolveIndexedRecording(link, ac.signal)
                        .then((audio) => {
                            this.pendingAutoTranscribe.delete(link);
                            // Superseded by a manual transcribe — do nothing (and
                            // don't cry "not indexed": that take is handled).
                            if (ac.signal.aborted) return;
                            if (!audio) {
                                console.warn(
                                    "[Meeting Copilot] auto-transcribe: recording not found in vault",
                                    link
                                );
                                new Notice(
                                    t().notices.autoTranscribeNotIndexed,
                                    10000
                                );
                                return;
                            }
                            return this.launchTranscriber(audio, "auto", {
                                fresh: true,
                            });
                        })
                        .catch((e) => {
                            this.pendingAutoTranscribe.delete(link);
                            console.warn(
                                "[Meeting Copilot] auto-transcribe failed",
                                e
                            );
                            if (!this.recorder.isRecording) this.hideStatusBar();
                        });
                }
                return;
            }
        }
        this.insertRecordingLink(fileName);
        } finally {
            // Release any back-to-back waiter now that the prior recording has
            // been fully linked/handled and shared state is clean.
            this.attaching = false;
            this.resolveStopWaiters();
        }
    }

    /**
     * Resolves a vault path to a TFile, retrying with a short backoff to give
     * Obsidian's file watcher time to index a file just written to disk by the
     * recorder helper (otherwise auto-transcribe would silently skip it).
     */
    private async resolveFileWithRetry(
        vaultPath: string,
        tries = 20,
        delayMs = 500
    ): Promise<TFile | null> {
        for (let i = 0; i < tries; i++) {
            const f = this.app.vault.getAbstractFileByPath(vaultPath);
            if (f instanceof TFile) return f;
            await new Promise((r) => setTimeout(r, delayMs));
        }
        const f = this.app.vault.getAbstractFileByPath(vaultPath);
        return f instanceof TFile ? f : null;
    }

    /**
     * Resolves a just-recorded audio path to a TFile, tolerant of arbitrary
     * index lag. Unlike {@link resolveFileWithRetry}'s fixed poll, this is
     * event-driven ({@link awaitIndexedFile}): it waits on the vault `create`
     * event for the path (with a poll backstop + hard cap), so a slow watcher
     * (cloud-synced vault, or App Nap throttling while the app is backgrounded
     * during a meeting) resolves whenever the index finally catches up. `signal`
     * lets a manual transcribe of the same take cancel the wait.
     */
    private resolveIndexedRecording(
        vaultPath: string,
        signal: AbortSignal
    ): Promise<TFile | null> {
        return awaitIndexedFile<TFile>(
            vaultPath,
            {
                getIndexed: (p) => {
                    const f = this.app.vault.getAbstractFileByPath(p);
                    if (f instanceof TFile) return f;
                    // Case-insensitive fallback: on a case-insensitive FS the
                    // recorder writes to the settings-cased path (e.g.
                    // "Meetings/…") but Obsidian may index the folder under a
                    // different case ("meetings/…"), so the exact, case-SENSITIVE
                    // lookup misses even though the file is indexed — and
                    // existsOnDisk (also case-insensitive) then keeps us waiting
                    // the full cap for a file that's already there. Mirror the
                    // manual path's tolerance (getFirstLinkpathDest is
                    // case-insensitive) so auto-transcribe resolves it too.
                    return findByPathCaseInsensitive(
                        this.app.vault.getFiles(),
                        p
                    );
                },
                existsOnDisk: (p) => this.app.vault.adapter.exists(p),
                onCreate: (cb) => {
                    // awaitIndexedFile always calls the returned unsubscribe on
                    // settle (resolve/cap/abort), and onunload aborts every
                    // pending wait, so the listener is removed on all paths
                    // without a separate registerEvent.
                    const ref = this.app.vault.on("create", (file) =>
                        cb(file.path)
                    );
                    return () => this.app.vault.offref(ref);
                },
                setTimeout: (fn, ms) => window.setTimeout(fn, ms),
                clearTimeout: (h) => window.clearTimeout(h),
            },
            { signal }
        );
    }

    /** Aborts and forgets any pending auto-transcribe wait for a recording path. */
    private cancelPendingAutoTranscribe(vaultPath: string): void {
        const ac = this.pendingAutoTranscribe.get(vaultPath);
        if (ac) {
            ac.abort();
            this.pendingAutoTranscribe.delete(vaultPath);
        }
    }

    /**
     * The folder a meeting note's recording should be written to: the configured
     * "Recordings" subfolder of the note's own folder, or the note's folder
     * itself when the subfolder is blank (colocated, pre-0.2 behavior).
     */
    private recordingFolderFor(noteFolder: string): string {
        const sub = this.settings.recordingSubfolder
            .trim()
            .replace(/^\/+|\/+$/g, "");
        if (!sub) return noteFolder;
        return normalizePath(noteFolder ? `${noteFolder}/${sub}` : sub);
    }

    /** The recording container for new recordings, from the compression toggle. */
    private recordingFormat(): RecordingFormat {
        return this.settings.compressedRecordings ? "m4a" : "wav";
    }

    /**
     * Returns a vault-relative recording path in the given format, appending
     * -2, -3… if the name is taken. The format is passed in (sampled once per
     * start) so the path extension can't diverge from the helper's --format
     * if the settings toggle flips mid-start. The stem must be free across
     * every recording format, not just the configured one: `foo.wav` and
     * `foo.m4a` would share the extension-less `foo.speech.json` sidecar, so
     * a new m4a next to a pre-toggle wav would overwrite the wav's speech
     * windows and retention of one would trash the other's sidecar.
     */
    private async uniqueRecordingPath(
        adapter: import("obsidian").DataAdapter,
        folder: string,
        basename: string,
        ext: RecordingFormat
    ): Promise<string> {
        // normalizePath drops the leading slash when folder is "" (vault root).
        // A stem is taken if its primary file OR any of its convention-based
        // sidecars already exist, in either format: on stop the split sidecars
        // are moved to `<stem>.me/.them.<fmt>` / `<stem>.speech.json` by naming
        // convention, so a pre-existing file at one of those paths (e.g. an
        // orphaned sidecar) would otherwise be silently overwritten.
        const stemTaken = async (stem: string): Promise<boolean> => {
            for (const fmt of RECORDING_FORMATS) {
                if (await adapter.exists(normalizePath(`${stem}.${fmt}`))) {
                    return true;
                }
                const sc = sidecarPathsFor(`${stem}.${fmt}`);
                for (const p of [sc.me, sc.them, sc.speech]) {
                    if (await adapter.exists(normalizePath(p))) return true;
                }
            }
            return false;
        };
        let stem = `${folder}/${basename}`;
        let n = 2;
        while (await stemTaken(stem)) {
            stem = `${folder}/${basename}-${n}`;
            n++;
        }
        return normalizePath(`${stem}.${ext}`);
    }

    private insertRecordingLink(fileName: string) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) {
            const editor = view.editor;
            const cursor = editor.getCursor();
            editor.replaceRange(`![[${fileName}]]\n`, cursor);
        }
    }

    // MARK: - Helpers
}
