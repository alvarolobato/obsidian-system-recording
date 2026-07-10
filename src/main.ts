import { FileSystemAdapter, MarkdownView, Menu, normalizePath, Notice, Platform, Plugin, setIcon, TFile } from "obsidian";
import {
    DEFAULT_SETTINGS,
    STT_MODELS,
    SystemRecordingSettings,
    SystemRecordingSettingTab,
} from "./settings";
import { Recorder, RecorderStatus } from "./recorder";
import { BinaryProvisioner } from "./binary";
import { nodeDeps, resolveBinaryPath } from "./binary-runtime";
import * as path from "path";
import { GoogleOAuth } from "./auth/googleOAuth";
import { listEvents } from "./calendar/googleCalendar";
import { parseKeywords } from "./calendar/eventFilter";
import { CalendarScheduler, ScheduledEvent } from "./calendar/scheduler";
import { actionNotice } from "./ui/actionNotice";
import {
    createMeetingNote,
    findMeetingNoteForAudio,
    insertTranscript,
    linkRecording,
    MeetingEventInfo,
    MeetingNoteConfig,
    recordingLinkTarget,
    upsertSection,
} from "./notes/meetingNote";
import {
    extractSection,
    extractTranscript,
    HIDE_AI_CLASS,
    withEnrichedBlock,
} from "./notes/enrichedBlock";
import { extractActionItems, mergeActionItems } from "./notes/actionItems";
import { buildDashboardBlock, withDashboardBlock } from "./notes/dashboard";
import { findExpiredRecordings } from "./recordings/retention";

/** Note section that holds action-item checkboxes (obsidian-tasks compatible). */
const ACTION_ITEMS_HEADING = "## Action items";
import { chatComplete } from "./enrich/llm";
import { isPartialTranscript } from "./transcribe/partial";
import {
    initTranscribeEngine,
    transcribeAudio,
    type TranscribeConfig,
} from "./transcribe/TranscriptionService";
import { parseDictionary } from "./transcribe/dictionary";
import type { TranscriptionModel } from "./transcribe/vendor/ApiSettings";
import { ENRICH_SYSTEM_PROMPT, fillPrompt } from "./enrich/prompt";
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

export default class SystemRecordingPlugin extends Plugin {
    settings: SystemRecordingSettings;
    private recorder = new Recorder();
    private provisioner = new BinaryProvisioner(nodeDeps());
    private starting = false;
    private statusBarEl: HTMLElement | null = null;
    private statusTimeout: number | null = null;
    private durationInterval: number | null = null;
    private recordingStartTime: number | null = null;
    private ribbonIconEl: HTMLElement | null = null;
	private oauth = new GoogleOAuth({
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
	});
	private scheduler: CalendarScheduler | null = null;
	/** Note the in-progress recording belongs to, so we can link it back on stop. */
	private currentMeetingNotePath: string | null = null;
	/** Calendar event id of the in-progress meeting recording, for agenda state. */
	private currentRecordingEventId: string | null = null;
	/** Vault-relative path of the in-progress recording, protected from retention. */
	private currentRecordingPath: string | null = null;
	/** Note paths currently being enriched, to prevent overlapping LLM runs. */
	private enrichingPaths = new Set<string>();
	/** Audio paths currently being transcribed, to prevent overlapping runs. */
	private transcribingPaths = new Set<string>();
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
        this.ribbonIconEl = this.addRibbonIcon(
            "microphone",
            t().ribbon.toggleRecording,
            () => this.toggleRecording()
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

        // Status bar
        this.statusBarEl = this.addStatusBarItem();
        this.statusBarEl.addClass("system-recording-hidden");

        // Commands
        this.addCommand({
            id: "start-recording",
            name: t().commands.startRecording,
            callback: () => this.startRecording(),
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
            new Notice(t().notices.recordingError(message));
            // Fatal failures (spawn error / non-zero exit) flip isRecording off
            // before invoking onError; a stderr line while still recording is
            // non-fatal, so only reset the UI when recording has truly stopped.
            if (!this.recorder.isRecording) this.resetRecordingUi();
        };

		this.updateScheduler();
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
		this.scheduler?.stop();
		this.agendaEvents.clear();
    }

    async loadSettings() {
        const raw = (await this.loadData()) as
            | (Partial<SystemRecordingSettings> & {
                  enrichBaseUrl?: string;
                  enrichApiKey?: string;
              })
            | null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
        // Migrate the previously enrichment-only endpoint into the shared fields.
        if (raw?.enrichBaseUrl && this.settings.apiBaseUrl === DEFAULT_SETTINGS.apiBaseUrl) {
            this.settings.apiBaseUrl = raw.enrichBaseUrl;
        }
        if (raw?.enrichApiKey && !this.settings.apiKey) {
            this.settings.apiKey = raw.enrichApiKey;
        }
        // Guard against corrupt/old data selecting an unknown STT model, which
        // would silently fall through to the GPT-4o path in the engine.
        if (!(STT_MODELS as readonly string[]).includes(this.settings.sttModel)) {
            this.settings.sttModel = DEFAULT_SETTINGS.sttModel;
        }
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    // MARK: - Recording control

    private toggleRecording() {
        if (this.recorder.isRecording) {
            this.stopRecording();
        } else {
            void this.startRecording();
        }
    }

    private async startRecording(meeting?: {
        folder: string;
        basename: string;
        notePath: string;
        eventId?: string;
    }) {
        if (this.recorder.isRecording) {
            new Notice(t().notices.alreadyRecording);
            return;
        }

        // A start is already in progress (binary provisioning may be awaiting)
        if (this.starting) {
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

            // Meeting recordings live beside their note (same folder + basename);
            // ad-hoc recordings fall back to the template in the recordings folder.
            let relativePath: string;
            if (meeting) {
                if (!(await adapter.exists(meeting.folder))) {
                    await adapter.mkdir(meeting.folder);
                }
                relativePath = await this.uniqueWavPath(
                    adapter,
                    meeting.folder,
                    meeting.basename
                );
                this.currentMeetingNotePath = meeting.notePath;
                this.currentRecordingEventId = meeting.eventId ?? null;
            } else {
                const folder = this.settings.recordingFolder;
                if (!(await adapter.exists(folder))) {
                    await adapter.mkdir(folder);
                }
                const fileName = this.formatFileName(this.settings.fileNameTemplate);
                relativePath = await this.uniqueWavPath(adapter, folder, fileName);
                this.currentMeetingNotePath = null;
                this.currentRecordingEventId = null;
            }

            this.currentRecordingPath = relativePath;
            const vaultBasePath =
                adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
            const absolutePath = path.join(vaultBasePath, relativePath);

            // Start recording
            this.recorder.start(binaryPath, absolutePath);
            this.recordingStartTime = Date.now();
            this.startDurationTimer();
            this.updateRibbonIcon(true);
            this.agendaEvents.emit("changed", undefined);

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

	// MARK: - Calendar integration

	isCalendarAuthenticated(): boolean {
		return this.oauth.isAuthenticated();
	}

	async authenticateCalendar(): Promise<void> {
		try {
			await this.oauth.authenticate();
			this.updateScheduler();
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e));
		}
	}

	/** Starts the scheduler when auto-record is on and authenticated; stops it otherwise. */
	updateScheduler(): void {
		const shouldRun =
			this.settings.calendarAutoRecord && this.oauth.isAuthenticated();
		if (shouldRun) {
			if (!this.scheduler) {
				this.scheduler = new CalendarScheduler({
					now: () => Date.now(),
					fetchEvents: (minMs, maxMs) => this.fetchCalendarEvents(minMs, maxMs),
					onEventStart: (event) => this.handleEventStart(event),
					onEventEnd: (event) => this.handleEventEnd(event),
					onError: (message) => new Notice(t().notices.calendarError(message)),
					registerInterval: (id) => this.registerInterval(id),
				});
			}
			if (!this.scheduler.isRunning) this.scheduler.start();
		} else {
			this.scheduler?.stop();
		}
	}

	/** Re-poll the calendar immediately (e.g. after changing the target calendar). No-op if not running. */
	refreshCalendarNow(): void {
		void this.scheduler?.poll();
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
		}));
	}

	private handleEventStart(event: ScheduledEvent): void {
		// Only open https links — meetLink comes from external calendar data,
		// so guard against javascript:/file:/custom-scheme URIs.
		if (
			event.meetLink &&
			this.settings.openMeetAutomatically &&
			event.meetLink.startsWith("https://")
		) {
			window.open(event.meetLink, "_blank");
		}
		actionNotice(
			t().event.started(event.summary),
			t().event.createNoteAndRecord,
			() => {
				void this.startMeetingRecording(this.toMeetingInfo(event));
			}
		);
	}

	/** Creates & opens the meeting note from calendar data, then records beside it. */
	private async startMeetingRecording(info: MeetingEventInfo): Promise<void> {
		if (!Platform.isMacOS) {
			new Notice(t().notices.macOnly);
			return;
		}
		try {
			const ref = await createMeetingNote(this.app, info, this.noteConfig());
			await this.app.workspace.getLeaf(false).openFile(ref.file);
			await this.startRecording({
				folder: ref.folder,
				basename: ref.basename,
				notePath: ref.notePath,
				eventId: info.id,
			});
		} catch (e) {
			new Notice(t().notices.recordingError(e instanceof Error ? e.message : String(e)));
		}
	}

	private noteConfig(): MeetingNoteConfig {
		return {
			baseFolder: this.settings.meetingsFolder,
			titlePattern: this.settings.noteTitlePattern,
			template: this.settings.noteTemplate,
		};
	}

	private toMeetingInfo(e: ScheduledEvent): MeetingEventInfo {
		return {
			id: e.id,
			summary: e.summary,
			start: new Date(e.start),
			end: new Date(e.end),
			meetLink: e.meetLink,
			location: e.location,
			htmlLink: e.htmlLink,
			attendees: e.attendees,
			organizer: e.organizer,
			iCalUID: e.iCalUID,
			recurringEventId: e.recurringEventId,
		};
	}

	private handleEventEnd(event: ScheduledEvent): void {
		// Only offer to stop when *this* meeting's recording is the active one,
		// so overlapping meetings can't stop the wrong recording (or prompt when
		// nothing is being recorded).
		if (
			!this.recorder.isRecording ||
			this.currentRecordingEventId !== event.id
		) {
			return;
		}
		actionNotice(
			t().event.ended(event.summary),
			t().event.stopRecordingAction,
			() => {
				this.stopRecording();
			}
		);
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
            isRecordingThis: (m) =>
                this.recorder.isRecording &&
                this.currentRecordingEventId === m.id,
            onOpenOrCreate: (m) => void this.openOrCreateNote(m),
            onCreateAndRecord: (m) =>
                void this.startMeetingRecording(agendaToMeetingInfo(m)),
            onCreateNote: (m) => void this.createNoteOnly(m),
            onStop: () => this.stopRecording(),
            onOpenRecording: (m) => void this.openRecording(m),
            onTranscribe: (m) => void this.transcribeRecording(m),
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
        return (
            nonEmpty("event_id") || nonEmpty("recording") || nonEmpty("meeting_url")
        );
    }

    /** Adds the shared meeting actions (record/transcribe/enrich/links) to a menu. */
    private addNoteMeetingMenu(menu: Menu, file: TFile): void {
        menu.addSeparator();
        populateMeetingMenu(
            menu,
            this.agendaMeetingFromNote(file),
            this.noteRowHandlers(),
            { includeNavigation: false }
        );
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
        const toDate = (v: unknown): Date => {
            const d = new Date(typeof v === "string" ? v : NaN);
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
            note: file,
            recording,
            status: str("status") || null,
        };
    }

    /** Row handlers wired to the plugin, for menus shown outside the agenda view. */
    private noteRowHandlers(): RowHandlers {
        return {
            onOpenOrCreate: (m) => void this.openOrCreateNote(m),
            onCreateAndRecord: (m) =>
                void this.startMeetingRecording(agendaToMeetingInfo(m)),
            onCreateNote: (m) => void this.createNoteOnly(m),
            onStop: () => this.stopRecording(),
            onOpenRecording: (m) => void this.openRecording(m),
            onTranscribe: (m) => void this.transcribeRecording(m),
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
            isRecordingThis: (m) =>
                this.recorder.isRecording &&
                this.currentRecordingEventId === m.id,
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

    /** Transcribes the meeting's recording with the built-in engine. */
    private async transcribeRecording(m: AgendaMeeting): Promise<void> {
        if (!m.recording) {
            new Notice(t().agenda.notices.noRecording);
            return;
        }
        await this.launchTranscriber(m.recording);
    }

    /** Maps plugin settings onto the vendored transcription engine's config. */
    private buildTranscribeConfig(): TranscribeConfig {
        const s = this.settings;
        return {
            baseUrl: s.apiBaseUrl,
            apiKey: s.apiKey,
            model: s.sttModel as TranscriptionModel,
            modelOverride: s.sttModelId,
            language: s.sttLanguage || "auto",
            vadMode: s.vadMode,
            postProcessingEnabled: s.postProcessingEnabled,
            dictionaryCorrectionEnabled: s.dictionaryCorrectionEnabled,
            userDictionaries: parseDictionary(s.dictionary),
            debugMode: false,
        };
    }

    /**
     * Transcribes an audio file with the vendored engine (headless — no modal,
     * no separate transcript file). The transcript text is routed through the
     * same insert+enrich path used elsewhere.
     */
    private async launchTranscriber(recording: TFile): Promise<void> {
        if (!this.settings.apiBaseUrl || !this.settings.apiKey) {
            new Notice(t().notices.transcribeNoEndpoint);
            return;
        }
        // Guard against overlapping runs (double-click, or auto-transcribe
        // racing a manual trigger) — each would cost an API call and write.
        if (this.transcribingPaths.has(recording.path)) {
            new Notice(t().notices.transcribeInProgress);
            return;
        }
        this.transcribingPaths.add(recording.path);
        this.setActionStatus(t().statusBar.transcribing, "busy");
        try {
            const text = await transcribeAudio(
                this.app,
                recording,
                this.buildTranscribeConfig()
            );
            const trimmed = text.trim();
            if (!trimmed) {
                new Notice(t().notices.transcribeEmpty);
                if (!this.recorder.isRecording) this.clearActionStatus();
                return;
            }
            // A partial/failed run comes back as a marker-prefixed string
            // (not clean transcript text), so don't insert it as the transcript.
            if (isPartialTranscript(trimmed)) {
                new Notice(t().notices.transcribePartial);
                this.setActionStatus(t().statusBar.transcribeFailed, "error");
                return;
            }
            const noteFound = await this.handleTranscriptionCompleted({
                audioFile: recording,
                transcription: text,
                file: null,
            });
            if (!noteFound) {
                new Notice(t().notices.transcribeNoNote(recording.basename));
            }
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // The engine throws the partial text (marker-prefixed) for a
            // partial/failed run rather than returning it, so classify it.
            if (isPartialTranscript(msg)) {
                new Notice(t().notices.transcribePartial);
            } else {
                new Notice(t().notices.transcribeError(msg));
            }
            this.setActionStatus(t().statusBar.transcribeFailed, "error");
        } finally {
            this.transcribingPaths.delete(recording.path);
        }
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
                this.resetRecordingUi();
            }
        } else if (status.status === "error") {
            this.resetRecordingUi();
            new Notice(
                t().notices.recordingError(status.message ?? t().notices.unknownError)
            );
        }
    }

    // MARK: - UI helpers

    private startDurationTimer() {
        // Drop any leftover action-status spinner/styling before the timer owns the bar.
        this.clearActionStatus();
        if (this.statusBarEl) {
            this.statusBarEl.removeClass("system-recording-hidden");
        }

        this.durationInterval = window.setInterval(() => {
            if (!this.recordingStartTime || !this.statusBarEl) return;
            const elapsed = Math.floor(
                (Date.now() - this.recordingStartTime) / 1000
            );
            const h = String(Math.floor(elapsed / 3600)).padStart(2, "0");
            const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
            const s = String(elapsed % 60).padStart(2, "0");
            this.statusBarEl.setText(t().statusBar.recording(`${h}:${m}:${s}`));
        }, 1000);

        this.registerInterval(this.durationInterval);
    }

    private clearDurationTimer() {
        if (this.durationInterval !== null) {
            window.clearInterval(this.durationInterval);
            this.durationInterval = null;
        }
    }

    /** Returns all recording UI/state to idle after a stop or failure. */
    private resetRecordingUi() {
        this.clearDurationTimer();
        this.updateRibbonIcon(false);
        this.currentRecordingPath = null;
        this.hideStatusBar();
        this.currentMeetingNotePath = null;
        this.currentRecordingEventId = null;
        this.agendaEvents.emit("changed", undefined);
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
    }

    private hideStatusBar() {
        this.clearActionStatus();
        if (this.statusBarEl) {
            this.statusBarEl.addClass("system-recording-hidden");
        }
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

    /** Inserts a finished transcription into its meeting note, then refreshes the agenda. */
    /** Returns true when a matching meeting note was found (regardless of insert). */
    private async handleTranscriptionCompleted(
        payload: unknown
    ): Promise<boolean> {
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
                        await insertTranscript(this.app, note, transcript);
                        new Notice(t().notices.transcriptAdded(note.basename));
                        inserted = true;
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
        if (
            enrichTarget &&
            this.settings.enableEnrichment &&
            this.settings.enrichOnTranscribe
        ) {
            // Pass the fresh transcript so enrichment works even when
            // insertTranscript is off and the note has no transcript yet.
            await this.enrichMeetingNote(enrichTarget, transcriptText ?? undefined);
        }
        return enrichTarget !== null;
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
        try {
            const content = await this.app.vault.read(file);
            const notes = extractSection(content, "## Notes");
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
            this.setActionStatus(t().statusBar.enriching, "busy");
            const output = await chatComplete({
                baseUrl: apiBaseUrl,
                apiKey: apiKey,
                model: enrichModel,
                system: ENRICH_SYSTEM_PROMPT,
                user: fillPrompt(this.settings.enrichPrompt, ctx),
            });
            // Re-read in case the note changed during the network call.
            const current = await this.app.vault.read(file);
            let updated = current;
            let calloutBody = output;
            // Lift action items out of the summary into real obsidian-tasks
            // checkboxes under "## Action items" (merged, never duplicated).
            if (this.settings.actionItemsAsTasks) {
                const { items, without } = extractActionItems(output);
                if (items.length > 0) {
                    const existing = extractSection(updated, ACTION_ITEMS_HEADING);
                    const merged = mergeActionItems(existing, items);
                    updated = upsertSection(updated, ACTION_ITEMS_HEADING, merged);
                    calloutBody = without;
                }
            }
            updated = withEnrichedBlock(updated, calloutBody);
            await this.app.vault.modify(file, updated);
            await this.app.fileManager.processFrontMatter(file, (f) => {
                (f as Record<string, unknown>).status = "enriched";
            });
            new Notice(t().notices.enrichDone(file.basename));
            this.setActionStatus(t().statusBar.enriched, "success");
            this.agendaEvents.emit("changed", undefined);
        } catch (e) {
            new Notice(
                t().notices.enrichError(e instanceof Error ? e.message : String(e))
            );
            this.setActionStatus(t().statusBar.enrichFailed, "error");
        } finally {
            this.enrichingPaths.delete(file.path);
        }
    }

    /**
     * Moves recordings older than `retentionDays` to the trash so they don't
     * grow forever. Only touches audio files under the meetings/recordings
     * folders; the transcript already lives in the note, so the audio is safe
     * to prune. `retentionDays: 0` disables cleanup entirely.
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
            const expired = findExpiredRecordings(files, {
                folders: [
                    this.settings.meetingsFolder.trim() || "Meetings",
                    this.settings.recordingFolder.trim() || "recordings",
                ],
                retentionDays: this.settings.retentionDays,
                now: Date.now(),
                protectedPaths: this.currentRecordingPath
                    ? new Set([this.currentRecordingPath])
                    : undefined,
            });

            let removed = 0;
            for (const info of expired) {
                const file = this.app.vault.getAbstractFileByPath(info.path);
                if (!(file instanceof TFile)) continue;
                // Resolve the note that actually links THIS audio (verified, so we
                // never touch a note that points at a different/newer recording).
                const note = this.noteOwningRecording(file);
                // Protect audio linked to a note that hasn't captured its content
                // yet: only prune once the meeting is transcribed/enriched.
                if (note && !this.isTranscribedNote(note)) continue;
                try {
                    await this.app.fileManager.trashFile(file);
                    removed++;
                    // Drop the note's now-dangling link (transcript stays in the note).
                    if (note) {
                        await this.app.fileManager.processFrontMatter(note, (fm) => {
                            const f = fm as Record<string, unknown>;
                            delete f.recording;
                            f.recording_pruned = new Date()
                                .toISOString()
                                .slice(0, 10);
                        });
                    }
                } catch (e) {
                    console.warn(
                        `[Meeting Copilot] failed to trash ${info.path}`,
                        e
                    );
                }
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

    /** The note whose `recording` frontmatter link resolves to this audio file, if any. */
    private noteOwningRecording(audio: TFile): TFile | null {
        for (const f of this.app.vault.getMarkdownFiles()) {
            const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as
                | Record<string, unknown>
                | undefined;
            const rec = fm?.["recording"];
            if (typeof rec !== "string") continue;
            const link = (
                rec.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0] ?? ""
            ).trim();
            const dest = this.app.metadataCache.getFirstLinkpathDest(link, f.path);
            if (dest instanceof TFile && dest.path === audio.path) return f;
        }
        return null;
    }

    /** True once a meeting note's content has been captured (transcribed or enriched). */
    private isTranscribedNote(note: TFile): boolean {
        const fm = this.app.metadataCache.getFileCache(note)?.frontmatter as
            | Record<string, unknown>
            | undefined;
        const status = fm?.["status"];
        return status === "transcribed" || status === "enriched";
    }

    /**
     * Creates or refreshes a Dataview-powered meetings dashboard note. Only the
     * plugin-managed block between markers is rewritten, so user edits around it
     * survive re-runs.
     */
    private async createDashboard(): Promise<void> {
        const folder = this.settings.meetingsFolder.trim().replace(/\/+$/, "") ||
            "Meetings";
        if (!(await this.app.vault.adapter.exists(folder))) {
            await this.app.vault
                .createFolder(folder)
                .catch(() => {
                    /* created concurrently */
                });
        }
        const path = normalizePath(`${folder}/Meetings Dashboard.md`);
        const block = buildDashboardBlock(folder);
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
        const notePath = this.currentMeetingNotePath;
        this.currentMeetingNotePath = null;
        this.currentRecordingEventId = null;
        this.currentRecordingPath = null;
        this.agendaEvents.emit("changed", undefined);
        if (notePath) {
            const file = this.app.vault.getAbstractFileByPath(notePath);
            if (file instanceof TFile) {
                // Qualify the link with the recording's folder (it's colocated
                // with the note) so duplicate basenames elsewhere can't resolve
                // to the wrong file.
                const slash = notePath.lastIndexOf("/");
                const folder = slash >= 0 ? notePath.slice(0, slash) : "";
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
                    const audio = this.app.vault.getAbstractFileByPath(link);
                    if (audio instanceof TFile) {
                        void this.launchTranscriber(audio).catch((e) => {
                            console.warn(
                                "[Meeting Copilot] auto-transcribe failed",
                                e
                            );
                            if (!this.recorder.isRecording) this.hideStatusBar();
                        });
                    }
                }
                return;
            }
        }
        this.insertRecordingLink(fileName);
    }

    /** Returns a vault-relative `.wav` path, appending -2, -3… if the name is taken. */
    private async uniqueWavPath(
        adapter: import("obsidian").DataAdapter,
        folder: string,
        basename: string
    ): Promise<string> {
        let candidate = `${folder}/${basename}.wav`;
        let n = 2;
        while (await adapter.exists(candidate)) {
            candidate = `${folder}/${basename}-${n}.wav`;
            n++;
        }
        return candidate;
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

    private formatFileName(template: string): string {
        const now = new Date();
        return template
            .replace("YYYY", String(now.getFullYear()))
            .replace("MM", String(now.getMonth() + 1).padStart(2, "0"))
            .replace("DD", String(now.getDate()).padStart(2, "0"))
            .replace("HH", String(now.getHours()).padStart(2, "0"))
            .replace("mm", String(now.getMinutes()).padStart(2, "0"))
            .replace("ss", String(now.getSeconds()).padStart(2, "0"));
    }
}
