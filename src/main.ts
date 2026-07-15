import { FileSystemAdapter, MarkdownView, Menu, normalizePath, Notice, Platform, Plugin, setIcon, TFile } from "obsidian";
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
import { BinaryProvisioner } from "./binary";
import { nodeDeps, resolveBinaryPath } from "./binary-runtime";
import * as path from "path";
import * as fs from "fs";
import { GoogleOAuth, type StoredTokens } from "./auth/googleOAuth";
import { listEvents } from "./calendar/googleCalendar";
import { parseKeywords } from "./calendar/eventFilter";
import { CalendarScheduler, GRACE_MS, ScheduledEvent } from "./calendar/scheduler";
import { actionNotice, multiActionNotice, NoticeAction } from "./ui/actionNotice";
import {
    ADHOC_ID_PREFIX,
    createMeetingNote,
    dropRecordingLink,
    findMeetingNoteForAudio,
    folderOf,
    insertTranscript,
    isAdhocId,
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
import { extractActionItems, refreshActionItems } from "./notes/actionItems";
import { normalizeManualNotes } from "./notes/manualNotes";
import {
    ATTENTION_BLOCK_LANG,
    buildDashboardBlock,
    withDashboardBlock,
} from "./notes/dashboard";
import { computeAttention, type AttentionInput } from "./notes/attention";
import { findExpiredRecordings, underFolder } from "./recordings/retention";

/** Note section that holds action-item checkboxes (obsidian-tasks compatible). */
const ACTION_ITEMS_HEADING = "## Action items";
import { chatComplete } from "./enrich/llm";
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
    buildTitlePrompt,
    ENRICH_SYSTEM_PROMPT,
    fillPrompt,
    TITLE_SYSTEM_PROMPT,
} from "./enrich/prompt";
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
import { notifyOs, requestNotificationPermission } from "./ui/osNotification";
import { MeetingPromptModal } from "./ui/meetingPromptModal";
import {
    QueueSnapshot,
    TranscriptionCancelledError,
    TranscriptionQueue,
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

export default class SystemRecordingPlugin extends Plugin {
    settings: SystemRecordingSettings;
    private recorder = new Recorder();
    private provisioner = new BinaryProvisioner(nodeDeps());
    private starting = false;
    /** Dedupe identical capture warnings so a flapping device can't spam. */
    private lastWarningMessage: string | null = null;
    private lastWarningAt = 0;
    private statusBarEl: HTMLElement | null = null;
    private statusTimeout: number | null = null;
    private durationInterval: number | null = null;
    private recordingStartTime: number | null = null;
    /** Hover popover listing the transcription queue (running + next few waiting). */
    private queuePopoverEl: HTMLElement | null = null;
    /** True while the pointer is over the status bar item (shows the popover). */
    private statusHovered = false;
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
	/** Note paths currently being enriched, to prevent overlapping LLM runs. */
	private enrichingPaths = new Set<string>();
	/** Visible, serial transcription queue (running + waiting), with cancellation. */
	private transcriptionQueue = new TranscriptionQueue((s) =>
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
	 * In-app meeting prompts currently on screen, keyed by meeting (calendar
	 * event id, or a detection key). A new prompt for the *same* key supersedes
	 * its predecessor (upcoming → start), while distinct meetings coexist so
	 * overlapping / post-wake catch-up prompts don't clobber each other.
	 */
	private meetingNotices = new Map<string, Notice>();
	/**
	 * The current "meeting ended — stop recording?" prompt, if any. A recording
	 * never stops on its own (unless the user opted into calendar auto-stop), so
	 * the end of a meeting only offers to stop; we keep one reference to supersede
	 * a stale prompt and to clear it once recording actually ends.
	 */
	private stopPromptNotice: Notice | null = null;
	/** Resolvers waiting for the current recording to fully stop (back-to-back chaining). */
	private stopWaiters: Array<() => void> = [];
	/** True while a stopped recording is still being linked/handled in attachRecording. */
	private attaching = false;
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
            (_src, el) => this.renderAttention(el)
        );

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
		this.updateDetector();
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
		this.statusHovered = false;
		this.hideQueuePopover();
		this.transcriptionQueue.cancelAll();
		this.scheduler?.stop();
		this.agendaEvents.clear();
		for (const notice of this.meetingNotices.values()) notice.hide();
		this.meetingNotices.clear();
		this.stopPromptNotice?.hide();
		this.stopPromptNotice = null;
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
        if (this.recorder.isRecording) {
            new Notice(t().notices.alreadyRecording);
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
            await this.startRecording({
                folder: ref.folder,
                basename: ref.basename,
                notePath: ref.notePath,
                eventId: info.id,
                note: ref.file,
            });
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
        if (this.recorder.isRecording) {
            // Back-to-back meetings: stop the prior recording (and let it finish
            // linking/auto-transcribing) before starting this one, so B's first
            // minutes aren't lost to an "already recording" bail.
            if (opts?.replaceCurrent) {
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
            // Ensure the recorder helper binary is present and verified
            let binaryPath: string;
            try {
                binaryPath = await this.provisioner.ensure(
                    resolveBinaryPath(this),
                    this.manifest.version,
                    () => new Notice(t().notices.downloadingHelper)
                );
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
            // A recording is now underway, so any pending "meeting detected —
            // record?" prompt is moot regardless of how this start was triggered.
            this.dismissMeetingNotices("detect:");

            new Notice(t().notices.recordingStarted);
        } finally {
            this.starting = false;
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
		this.dismissMeetingNotices(SystemRecordingPlugin.CAL_NOTICE_PREFIX);
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
			// No more boundary callbacks will fire, so sweep any calendar prompts
			// still on screen rather than leaving them stale (detection prompts,
			// driven separately, are left alone).
			this.dismissMeetingNotices(SystemRecordingPlugin.CAL_NOTICE_PREFIX);
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
			// No probe will fire onEnd now, so sweep any detection prompts still
			// on screen (mirrors the calendar sweep when the scheduler stops).
			this.dismissMeetingNotices("detect:");
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
		// moot — drop it whether or not we go on to offer a stop below.
		this.dismissMeetingNotice(`detect:${app}`);
		// Ignore if detection was disabled meanwhile (an in-flight poll's onEnd
		// must not prompt after the user opted out), and only act once *all*
		// detected meetings have ended so one of several concurrent calls ending
		// doesn't prompt while another is still live.
		if (!this.detector || this.detector.activeCount() > 0) return;
		if (!this.recorder.isRecording) return;
		this.promptStopRecording(t().detect.ended(app));
	}

	/**
	 * Offers to stop the current recording (a recording never stops on its own).
	 * Supersedes any prior stop prompt so end-of-meeting triggers that overlap
	 * (detected-meeting end + calendar event end) don't stack two notices.
	 */
	private promptStopRecording(message: string): void {
		this.stopPromptNotice?.hide();
		this.stopPromptNotice = actionNotice(
			message,
			t().event.stopRecordingAction,
			() => {
				this.stopPromptNotice = null;
				this.stopRecording();
			}
		);
	}

	/**
	 * Prompts the user to act on an upcoming/starting meeting. Two channels fire
	 * together, regardless of window focus (a focused-but-elsewhere user — other
	 * Space/monitor, Obsidian behind other windows — would otherwise miss it):
	 *
	 *  - a **native OS notification** (title = meeting name, body = timing +
	 *    hint) whose click focuses Obsidian and opens the rich prompt modal, and
	 *  - an in-app **multi-action Notice** with the same buttons for when
	 *    Obsidian is already in front.
	 *
	 * Web Notifications can't render action buttons, so the notification is the
	 * attention-getter and the modal/notice carry the actual choices. `onRecord`
	 * is the record action; a valid https `meetLink` adds the Join affordances,
	 * and an `onOpenNote` adds an "Open note" action (Granola-style).
	 */
	private promptMeeting(opts: {
		/** Stable per-meeting key: a same-key reprompt supersedes, distinct keys coexist. */
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
		const link =
			opts.meetLink && opts.meetLink.startsWith("https://")
				? opts.meetLink
				: null;
		// Every channel (in-app notice, native OS buttons, modal) shares these
		// handlers, and each first dismisses the in-app notice for this meeting:
		// acting from the OS notification or the modal must not leave the parallel
		// in-app Notice lingering on screen.
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

		// In-app multi-action notice (guaranteed path when Obsidian is in front).
		// Order mirrors the modal / Granola: a combined primary (Join & record)
		// when there's a link — else Record — then Join, then Open note. The
		// combined action is the record path when a link exists, so no separate
		// Record button is needed there.
		const e = t().event;
		const actions: NoticeAction[] = [];
		if (onJoinAndRecord) {
			actions.push({ label: e.joinAndRecord, onClick: onJoinAndRecord, cta: true });
			if (onJoin) actions.push({ label: e.join, onClick: onJoin });
		} else {
			actions.push({ label: e.record, onClick: onRecord, cta: true });
		}
		if (onOpenNote)
			actions.push({ label: e.openNote, onClick: onOpenNote });
		// Supersede an earlier prompt for the *same* meeting (e.g. the lead-time
		// notice when the start boundary now fires) rather than stacking a second
		// persistent notice — but leave other meetings' prompts alone so
		// overlapping meetings each keep theirs.
		this.meetingNotices.get(opts.key)?.hide();
		this.meetingNotices.set(
			opts.key,
			multiActionNotice(
				`${opts.title} — ${opts.subtitle}`,
				actions,
				// Once the user picks an action the notice is gone — drop our
				// bookkeeping entry so the map only ever holds live prompts.
				() => this.meetingNotices.delete(opts.key)
			)
		);

		// Native OS notification (visible while minimized / on another Space).
		// When the platform supports it the same actions render as real macOS
		// buttons (first inline, rest under the notification's dropdown); its
		// body click — and the no-actions fallback banner — opens the rich modal.
		notifyOs(
			opts.title,
			`${opts.subtitle} · ${e.notificationHint}`,
			() => {
				new MeetingPromptModal(this.app, {
					title: opts.title,
					subtitle: opts.subtitle,
					hasLink: link !== null,
					joinLabel: e.join,
					recordLabel: e.record,
					joinAndRecordLabel: e.joinAndRecord,
					openNoteLabel: e.openNote,
					dismissLabel: e.dismiss,
					onJoin: onJoin ?? ((): void => undefined),
					onRecord,
					onJoinAndRecord: onJoinAndRecord ?? onRecord,
					onOpenNote,
				}).open();
			},
			actions.map((a) => ({ text: a.label, run: a.onClick }))
		);
	}

	/** Prefix for calendar-event prompt keys (vs. `detect:` for detected meetings). */
	private static readonly CAL_NOTICE_PREFIX = "cal:";

	/**
	 * Dismisses the persistent meeting prompt for one key (if any). Used once a
	 * decision has been made for the meeting (auto-start fired, we're already
	 * recording it, or it just ended) so a now-stale prompt doesn't linger or
	 * stack under a new one.
	 */
	private dismissMeetingNotice(key: string): void {
		this.meetingNotices.get(key)?.hide();
		this.meetingNotices.delete(key);
	}

	/** Dismisses every live prompt whose key starts with `prefix`. */
	private dismissMeetingNotices(prefix: string): void {
		for (const [key, notice] of this.meetingNotices) {
			if (!key.startsWith(prefix)) continue;
			notice.hide();
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
			titlePattern: this.settings.noteTitlePattern,
			template: this.settings.noteTemplate,
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
		// (same id, re-added by a poll) can open its link afresh, and drop any
		// lingering upcoming/start prompt for it (whether or not we recorded).
		this.openedLinkEventIds.delete(event.id);
		this.dismissMeetingNotice(SystemRecordingPlugin.CAL_NOTICE_PREFIX + event.id);

		// Only act when *this* meeting's recording is the active one, so
		// overlapping meetings can't stop the wrong recording (or prompt when
		// nothing is being recorded).
		if (
			!this.recorder.isRecording ||
			this.currentRecordingEventId !== event.id
		) {
			return;
		}

		// A recording never stops on its own — offer to stop — *unless* the user
		// opted into calendar auto-stop, in which case the meeting's own end (even
		// one crossed late after a wake) stops it.
		if (this.settings.calendarAutoStop) {
			new Notice(t().event.autoStopped(event.summary));
			this.stopRecording();
			return;
		}
		this.promptStopRecording(t().event.ended(event.summary));
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
                if (m.note) void this.enrichMeetingNote(m.note);
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
            const hasRecording = recordingLinkTarget(entry.recording) !== "";
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
            byPath.set(entry.file.path, entry.file);
            inputs.push({
                path: entry.file.path,
                title,
                start: entry.stamp ? parseStampDate(entry.stamp) : null,
                status: entry.status,
                hasRecording,
            });
        }

        const rows = computeAttention(inputs, new Date());

        const header = el.createDiv({ cls: "mc-attention-header" });
        header.createSpan({ text: d.count(rows.length) });
        const refresh = header.createEl("button", { text: d.refresh });
        refresh.onclick = () => this.renderAttention(el);

        if (rows.length === 0) {
            el.createEl("p", { text: d.allClear, cls: "mc-attention-empty" });
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
            enBtn.onclick = (): void => void this.enrichMeetingNote(file);
        }
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
                if (m.note) void this.enrichMeetingNote(m.note);
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
     */
    private shouldSeparateSpeakers(): boolean {
        return canSeparateSpeakers(
            this.settings,
            probeKey(this.settings.apiBaseUrl, this.settings.sttModel)
        );
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
            this.app,
            meFile,
            themFile,
            this.buildTranscribeConfig(),
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
     * {@link TranscriptionQueue}, so a second request waits (and is shown as
     * queued) rather than fighting the first. The transcription slot is released
     * as soon as the transcript is inserted; enrichment then runs *outside* the
     * queue so a slow LLM call doesn't hold up the next transcription (or keep
     * the recording flagged in-progress, which used to block a re-transcribe).
     *
     * `mode` picks the pass: "auto" respects the speaker-separation setting,
     * "diarized" forces the separated pass (falling back to the joint track when
     * no separate tracks exist), and "mixed" always transcribes the joint track.
     */
    private async launchTranscriber(
        recording: TFile,
        mode: TranscribeMode = "auto",
        opts?: { fresh?: boolean }
    ): Promise<void> {
        // "fresh" = the auto-transcribe fired right after a stop (vs. a manual
        // re-transcribe). The fresh path appends its transcript to any existing
        // one (so a new take extends the meeting) and may auto-discard an empty
        // result as silence; a manual re-transcribe replaces. A multi-take
        // manual rebuild has its own path (rebuildTranscriptFromTakes).
        const fresh = opts?.fresh ?? false;
        if (!this.settings.apiBaseUrl || !this.settings.apiKey) {
            new Notice(t().notices.transcribeNoEndpoint);
            return;
        }
        // Dedupe overlapping runs (double-click, or auto-transcribe racing a
        // manual trigger) — each would cost an API call and write.
        if (this.transcriptionQueue.has(recording.path)) {
            new Notice(t().notices.transcribeInProgress);
            return;
        }
        const label = this.transcribeLabelFor(recording);
        // A run already occupies the single slot, so this one will wait; say so.
        if (this.transcriptionQueue.snapshot().running) {
            new Notice(t().notices.transcribeQueued(label));
        }

        // A holder (not a closed-over `let`) so TypeScript keeps the value's type
        // after the await instead of narrowing it to the initializer.
        const enrichAfter: { value: { note: TFile; transcript: string } | null } = {
            value: null,
        };
        try {
            await this.transcriptionQueue.enqueue({
                id: recording.path,
                label,
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
        } catch (e) {
            // Cancellation is expected; other failures were already surfaced with
            // their own notice/status inside transcribeToNote.
            if (!(e instanceof TranscriptionCancelledError)) {
                console.warn("[Meeting Copilot] transcription failed", e);
            }
            return;
        }

        const pending = enrichAfter.value;
        if (
            pending &&
            this.settings.enableEnrichment &&
            this.settings.enrichOnTranscribe
        ) {
            // Pass the fresh transcript so enrichment works even when
            // insertTranscript is off and the note has no transcript yet.
            await this.enrichMeetingNote(pending.note, pending.transcript);
        }
    }

    /**
     * Transcribes one recording (take) to ready-to-insert text, without writing
     * to any note — the shared core of the single-take writer
     * ({@link transcribeToNote}) and the multi-take rebuild
     * ({@link rebuildTranscriptFromTakes}). Drives the shared progress bar and
     * classifies the outcome (see {@link TranscribeTakeResult}). User
     * cancellation throws {@link TranscriptionCancelledError} so the queue
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
            if (this.transcriptionQueue.snapshot().running?.id !== recording.path) {
                return;
            }
            const rounded = Math.round(pct);
            this.runningProgress = { id: recording.path, pct: rounded };
            this.setActionStatus(
                this.transcribeStatusText(
                    label,
                    rounded,
                    this.transcriptionQueue.waitingCount
                ),
                "busy"
            );
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
            const diarizedText = wantDiarized
                ? await this.tryDiarizedTranscribe(
                      recording,
                      mode === "diarized",
                      onProgress,
                      signal
                  )
                : null;
            const diarized = diarizedText !== null;
            const rawText =
                diarizedText ??
                (await transcribeAudio(
                    this.app,
                    recording,
                    this.buildTranscribeConfig(),
                    signal,
                    onProgress
                ));
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
                throw new TranscriptionCancelledError();
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
        if (takes.some((take) => this.transcriptionQueue.has(take.path))) {
            new Notice(t().notices.transcribeInProgress);
            return;
        }
        const label = this.meetingNoteLabel(note);
        const segments: string[] = [];
        let allText = true;
        try {
            for (const take of takes) {
                if (this.transcriptionQueue.snapshot().running) {
                    new Notice(t().notices.transcribeQueued(label));
                }
                const outcome: { value: TranscribeTakeResult | null } = {
                    value: null,
                };
                await this.transcriptionQueue.enqueue({
                    id: take.path,
                    label,
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
            if (!(e instanceof TranscriptionCancelledError)) {
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
            await this.enrichMeetingNote(note, combined);
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
        // own rather than clearing it here.
        if (this.recorder.isRecording || !snapshot.running) return;
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

    /** Enter/leave the status bar: reveal or tear down the queue popover. */
    private setStatusHover(hovering: boolean): void {
        this.statusHovered = hovering;
        if (!hovering) {
            this.hideQueuePopover();
            return;
        }
        const snapshot = this.transcriptionQueue.snapshot();
        if (snapshot.running || snapshot.waiting.length > 0)
            this.showQueuePopover(snapshot);
    }

    /**
     * Shows (or refreshes) the roll-up panel above the status bar listing the
     * job being transcribed plus the next few waiting behind it. Display-only
     * (no pointer events) so moving onto it never steals the hover and flickers.
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
        }
        const el = this.queuePopoverEl;
        el.empty();
        el.createDiv({
            cls: "mc-queue-popover-title",
            text: t().statusBar.queuePopoverTitle,
        });
        const list = el.createDiv({ cls: "mc-queue-popover-list" });
        // `running` is momentarily null between jobs; still show the queue then.
        if (snapshot.running) {
            const running = list.createDiv({
                cls: "mc-queue-popover-item is-running",
            });
            setIcon(
                running.createSpan({ cls: "mc-queue-popover-icon" }),
                "loader-2"
            );
            running.createSpan({
                cls: "mc-queue-popover-label",
                text: snapshot.running.label,
            });
        }
        const limit = SystemRecordingPlugin.QUEUE_POPOVER_LIMIT;
        for (const item of snapshot.waiting.slice(0, limit)) {
            const row = list.createDiv({ cls: "mc-queue-popover-item" });
            setIcon(row.createSpan({ cls: "mc-queue-popover-icon" }), "clock");
            row.createSpan({ cls: "mc-queue-popover-label", text: item.label });
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

    /** Removes the queue hover popover. */
    private hideQueuePopover(): void {
        this.queuePopoverEl?.remove();
        this.queuePopoverEl = null;
    }

    /** Cancels the running transcription and drops any queued behind it (command-palette action). */
    private cancelActiveTranscription(): void {
        const snapshot = this.transcriptionQueue.snapshot();
        if (!snapshot.running && snapshot.waiting.length === 0) {
            new Notice(t().notices.nothingTranscribing);
            return;
        }
        this.transcriptionQueue.cancelAll();
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
            // Best-effort: only list if the binary is already on disk; never
            // trigger a download just to populate the dropdown on open.
            if (!fs.existsSync(binaryPath)) return [];
        } else {
            try {
                await this.provisioner.ensure(
                    binaryPath,
                    this.manifest.version,
                    () => new Notice(t().notices.downloadingHelper)
                );
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
                this.promptStopRecording(t().event.ended(title));
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
            const snapshot = this.transcriptionQueue.snapshot();
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
        this.stopPromptNotice?.hide();
        this.stopPromptNotice = null;
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

    /** True while a transcription is actively running (it owns the status bar). */
    private get transcriptionRunning(): boolean {
        return this.transcriptionQueue.snapshot().running !== null;
    }

    /**
     * Enrichment/title status writes yield the status bar to an active
     * transcription (which now runs concurrently, since enrichment happens after
     * the queue slot is released). Keeps the bar single-owner: transcription
     * progress wins; enrichment shows its state only when the queue is idle.
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
        await this.enrichMeetingNote(file);
    }

    /** Generates AI notes from the note's manual notes + transcript and inserts a gray callout. */
    private async enrichMeetingNote(
        file: TFile,
        transcriptOverride?: string
    ): Promise<void> {
        if (!this.settings.enableEnrichment) {
            new Notice(t().notices.enrichDisabled);
            return;
        }
        const { apiBaseUrl, apiKey, enrichModel } = this.settings;
        if (!apiBaseUrl || !apiKey || !enrichModel) {
            new Notice(t().notices.enrichNotConfigured);
            return;
        }
        // Guard against overlapping runs on the same note (double-click, agenda
        // + command, or auto-enrich racing a manual enrich).
        if (this.enrichingPaths.has(file.path)) {
            new Notice(t().notices.enrichInProgress);
            return;
        }
        this.enrichingPaths.add(file.path);
        let enrichedOk = false;
        try {
            const content = await this.app.vault.read(file);
            // Gather manual notes wherever they were written (incl. above the
            // "## Notes" heading), not just the section body.
            const notes = normalizeManualNotes(content).notes;
            const transcript =
                transcriptOverride && transcriptOverride.trim().length > 0
                    ? transcriptOverride
                    : extractTranscript(content);
            if (!notes && !transcript) {
                new Notice(t().notices.nothingToEnrich);
                return;
            }

            const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ??
                {}) as Record<string, unknown>;
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
                transcript,
            };

            new Notice(t().notices.enriching);
            this.setEnrichStatus(t().statusBar.enriching, "busy");
            const output = await chatComplete({
                baseUrl: apiBaseUrl,
                apiKey: apiKey,
                model: enrichModel,
                system: ENRICH_SYSTEM_PROMPT,
                user: fillPrompt(this.settings.enrichPrompt, ctx),
            });
            // Re-read in case the note changed during the network call.
            const current = await this.app.vault.read(file);
            // The transcript callout has no heading of its own, so it lives
            // inside whatever section precedes it (usually "## Action items").
            // Pull it out before any section edits — otherwise extractSection
            // would scoop it up and merged action items would land *after* it —
            // and re-pin it to the very bottom once everything else is placed.
            const bottomTranscript = extractTranscript(current);
            let updated = bottomTranscript.trim().length
                ? stripTranscript(current)
                : current;
            // Consolidate any loose notes under "## Notes" (creating it if
            // missing) so they're preserved in place rather than orphaned.
            updated = normalizeManualNotes(updated).content;
            let calloutBody = output;
            // Lift action items out of the summary into real obsidian-tasks
            // checkboxes under "## Action items" (merged, never duplicated).
            if (this.settings.actionItemsAsTasks) {
                const { items, without } = extractActionItems(output);
                if (items.length > 0) {
                    const existing = extractSection(updated, ACTION_ITEMS_HEADING);
                    const merged = refreshActionItems(existing, items);
                    updated = upsertSection(updated, ACTION_ITEMS_HEADING, merged);
                    calloutBody = without;
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
            new Notice(
                t().notices.enrichError(e instanceof Error ? e.message : String(e))
            );
            this.setEnrichStatus(t().statusBar.enrichFailed, "error");
        } finally {
            this.enrichingPaths.delete(file.path);
        }

        // After the AI summary, offer a generated title for unplanned meetings
        // (once). Scheduled meetings keep their calendar title.
        if (
            enrichedOk &&
            this.settings.suggestAdhocTitle &&
            this.isAdhocNote(file) &&
            !this.titleAlreadySuggested(file)
        ) {
            await this.suggestAdhocTitle(file, transcriptOverride);
        }
    }

    /** True once we've offered an AI title for this note (flagged in frontmatter). */
    private titleAlreadySuggested(file: TFile): boolean {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
            | Record<string, unknown>
            | undefined;
        return fm?.["mc_title_suggested"] === true;
    }

    /** True for unplanned meetings (ad-hoc/detected), whose event_id we prefix "adhoc-". */
    private isAdhocNote(file: TFile): boolean {
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as
            | Record<string, unknown>
            | undefined;
        const id = fm?.["event_id"];
        return typeof id === "string" && isAdhocId(id);
    }

    /**
     * Asks the LLM for a title based on the notes/transcript and offers to
     * rename the note, keeping the date/time prefix. No-op on empty content.
     */
    private async suggestAdhocTitle(
        file: TFile,
        transcriptOverride?: string
    ): Promise<void> {
        const { apiBaseUrl, apiKey, enrichModel } = this.settings;
        if (!apiBaseUrl || !apiKey || !enrichModel) return;
        // Guard against a metadata-cache lag racing two offers for the same note.
        if (this.titleSuggestingPaths.has(file.path)) return;
        this.titleSuggestingPaths.add(file.path);
        try {
            const content = await this.app.vault.read(file);
            const notes = extractSection(content, "## Notes");
            const transcript =
                transcriptOverride && transcriptOverride.trim().length > 0
                    ? transcriptOverride
                    : extractTranscript(content);
            if (!notes && !transcript) return;

            this.setEnrichStatus(t().adhoc.suggestingTitle, "busy");
            const raw = await chatComplete({
                baseUrl: apiBaseUrl,
                apiKey,
                model: enrichModel,
                system: TITLE_SYSTEM_PROMPT,
                user: buildTitlePrompt(notes, transcript),
            });
            // Don't wipe a concurrent transcription's status; we only set ours
            // when the queue was idle.
            if (!this.transcriptionRunning) this.clearActionStatus();
            const title = this.cleanSuggestedTitle(raw);
            if (!title) return;

            // Mark as offered so we don't re-prompt on a later re-enrich.
            await this.app.fileManager.processFrontMatter(file, (f) => {
                (f as Record<string, unknown>).mc_title_suggested = true;
            });

            const prefix = this.datePrefixOf(file);
            const suggested = prefix ? `${prefix} ${title}` : title;
            new RenameModal(this.app, {
                heading: t().adhoc.titleModal.heading,
                desc: t().adhoc.titleModal.desc,
                value: suggested,
                renameLabel: t().adhoc.titleModal.rename,
                keepLabel: t().adhoc.titleModal.keep,
                onRename: (value) => {
                    void this.renameMeetingNote(file, value, prefix);
                },
            }).open();
        } catch (e) {
            console.warn("[Meeting Copilot] title suggestion failed", e);
            if (!this.transcriptionRunning) this.clearActionStatus();
        } finally {
            this.titleSuggestingPaths.delete(file.path);
        }
    }

    /** Reduces an LLM response to a single clean filename-safe title line. */
    private cleanSuggestedTitle(raw: string): string {
        const firstLine = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
        const unquoted = firstLine
            .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
            .replace(/[.。]+$/, "")
            .trim();
        return sanitizeName(unquoted).slice(0, 100).trim();
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
     * Creates or refreshes a Dataview-powered meetings dashboard note. Only the
     * plugin-managed block between markers is rewritten, so user edits around it
     * survive re-runs.
     */
    private async createDashboard(): Promise<void> {
        // Only decides where the dashboard *note* lives; the Dataview block
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
                const link = folder ? `${folder}/${fileName}` : fileName;
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
                    // The helper writes the recording directly to disk, so
                    // Obsidian's vault index may not have registered it as a
                    // TFile yet. Wait for it to appear before auto-transcribing.
                    void this.resolveFileWithRetry(link)
                        .then((audio) => {
                            if (!audio) {
                                // Losing the race for the whole retry window
                                // means the watcher likely missed the file; say
                                // so instead of silently skipping the headline
                                // automation (issue #29).
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
