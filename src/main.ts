import { FileSystemAdapter, MarkdownView, Notice, Platform, Plugin, TFile } from "obsidian";
import {
    DEFAULT_SETTINGS,
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
    linkRecording,
    MeetingEventInfo,
    MeetingNoteConfig,
} from "./notes/meetingNote";
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

export default class SystemRecordingPlugin extends Plugin {
    settings: SystemRecordingSettings;
    private recorder = new Recorder();
    private provisioner = new BinaryProvisioner(nodeDeps());
    private starting = false;
    private statusBarEl: HTMLElement | null = null;
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
	private agendaEvents = new TypedEventBus<AgendaViewEvents>();

    async onload() {
        await this.loadSettings();

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

        // Refresh the agenda when a transcription finishes (ai-transcriber emits this).
        this.registerEvent(
            this.app.workspace.on(
                // Custom event from the AI Transcriber plugin.
                "transcription:completed" as never,
                () => this.agendaEvents.emit("changed", undefined)
            )
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
		this.scheduler?.stop();
		this.agendaEvents.clear();
    }

    async loadSettings() {
        this.settings = Object.assign(
            {},
            DEFAULT_SETTINGS,
            await this.loadData() as Partial<SystemRecordingSettings>
        );
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
            onOpenLink: (url) => this.openMeetingLink(url),
            onCopyLink: (url) => void this.copyMeetingLink(url),
            openSettings: () => this.openPluginSettings(),
            events: this.agendaEvents,
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

    /** Opens the recording, then hands off to the AI Transcriber plugin if present. */
    private async transcribeRecording(m: AgendaMeeting): Promise<void> {
        if (!m.recording) {
            new Notice(t().agenda.notices.noRecording);
            return;
        }
        await this.app.workspace.getLeaf(false).openFile(m.recording);
        const commands = (
            this.app as unknown as {
                commands?: {
                    commands?: Record<string, unknown>;
                    executeCommandById?: (id: string) => boolean;
                };
            }
        ).commands;
        const id = Object.keys(commands?.commands ?? {}).find((k) =>
            k.startsWith("ai-transcriber:")
        );
        if (id && commands?.executeCommandById) {
            commands.executeCommandById(id);
        } else {
            new Notice(t().agenda.notices.transcriberMissing);
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
        this.hideStatusBar();
        this.currentMeetingNotePath = null;
        this.currentRecordingEventId = null;
        this.agendaEvents.emit("changed", undefined);
    }

    private hideStatusBar() {
        if (this.statusBarEl) {
            this.statusBarEl.addClass("system-recording-hidden");
            this.statusBarEl.setText("");
        }
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

    private async attachRecording(fileName: string) {
        const notePath = this.currentMeetingNotePath;
        this.currentMeetingNotePath = null;
        this.currentRecordingEventId = null;
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
