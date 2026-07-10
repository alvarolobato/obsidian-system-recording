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
import { shouldRecord, parseKeywords } from "./calendar/eventFilter";
import { CalendarScheduler, ScheduledEvent } from "./calendar/scheduler";
import { actionNotice } from "./ui/actionNotice";
import {
    createMeetingNote,
    linkRecording,
    MeetingEventInfo,
} from "./notes/meetingNote";
import { t } from "./i18n";

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

    async onload() {
        await this.loadSettings();

        // Ribbon icon
        this.ribbonIconEl = this.addRibbonIcon(
            "microphone",
            t().ribbon.toggleRecording,
            () => this.toggleRecording()
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
        this.recorder.onError = (message: string) =>
            new Notice(t().notices.recordingError(message));

		this.updateScheduler();
    }

    onunload() {
        if (this.recorder.isRecording) {
            this.recorder.stop();
        }
        this.clearDurationTimer();
		this.scheduler?.stop();
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
            } else {
                const folder = this.settings.recordingFolder;
                if (!(await adapter.exists(folder))) {
                    await adapter.mkdir(folder);
                }
                const fileName = this.formatFileName(this.settings.fileNameTemplate);
                relativePath = `${folder}/${fileName}.wav`;
                this.currentMeetingNotePath = null;
            }

            const vaultBasePath =
                adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
            const absolutePath = path.join(vaultBasePath, relativePath);

            // Start recording
            this.recorder.start(binaryPath, absolutePath);
            this.recordingStartTime = Date.now();
            this.startDurationTimer();
            this.updateRibbonIcon(true);

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
			new Date(maxMs)
		);
		const keywords = parseKeywords(this.settings.exclusionKeywords);
		return events
			.filter((e) => shouldRecord({ summary: e.summary, allDay: e.allDay }, keywords))
			.map((e) => ({
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
				void this.startMeetingRecording(event);
			}
		);
	}

	/** Creates & opens the meeting note from calendar data, then records beside it. */
	private async startMeetingRecording(event: ScheduledEvent): Promise<void> {
		if (!Platform.isMacOS) {
			new Notice(t().notices.macOnly);
			return;
		}
		try {
			const ref = await createMeetingNote(
				this.app,
				this.settings.meetingsFolder,
				this.toMeetingInfo(event)
			);
			await this.app.workspace.getLeaf(false).openFile(ref.file);
			await this.startRecording({
				folder: ref.folder,
				basename: ref.basename,
				notePath: ref.notePath,
			});
		} catch (e) {
			new Notice(t().notices.recordingError(e instanceof Error ? e.message : String(e)));
		}
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
		actionNotice(
			t().event.ended(event.summary),
			t().event.stopRecordingAction,
			() => {
				this.stopRecording();
			}
		);
	}

    // MARK: - Status handling

    private handleStatus(status: RecorderStatus) {
        if (status.status === "stopped" && status.file) {
            this.clearDurationTimer();
            this.updateRibbonIcon(false);
            this.hideStatusBar();

            const fileName = path.basename(status.file);
            // Meeting recordings are linked into their own note; ad-hoc ones go
            // to the active note as before.
            void this.attachRecording(fileName);
            new Notice(t().notices.recordingSaved);
        } else if (status.status === "error") {
            this.clearDurationTimer();
            this.updateRibbonIcon(false);
            this.hideStatusBar();
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
        if (notePath) {
            const file = this.app.vault.getAbstractFileByPath(notePath);
            if (file instanceof TFile) {
                await linkRecording(this.app, file, fileName);
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
