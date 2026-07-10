import { App, PluginSettingTab, Setting } from "obsidian";
import SystemRecordingPlugin from "./main";
import type { StoredTokens } from "./auth/googleOAuth";
import {
	DEFAULT_NOTE_TEMPLATE,
	DEFAULT_TITLE_PATTERN,
} from "./notes/meetingNote";
import { t } from "./i18n";

export interface SystemRecordingSettings {
	recordingFolder: string;
	fileNameTemplate: string;
	meetingsFolder: string;
	noteTitlePattern: string;
	noteTemplate: string;
	retentionDays: number;
	googleClientId: string;
	googleClientSecret: string;
	googleTokens: StoredTokens | null;
	calendarAutoRecord: boolean;
	calendarId: string;
	exclusionKeywords: string;
	openMeetAutomatically: boolean;
	agendaLookAheadDays: number;
	agendaLookBackDays: number;
}

export const DEFAULT_SETTINGS: SystemRecordingSettings = {
	recordingFolder: "recordings",
	fileNameTemplate: "recording-YYYY-MM-DD-HHmmss",
	meetingsFolder: "Meetings",
	noteTitlePattern: DEFAULT_TITLE_PATTERN,
	noteTemplate: DEFAULT_NOTE_TEMPLATE,
	retentionDays: 30,
	googleClientId: "",
	googleClientSecret: "",
	googleTokens: null,
	calendarAutoRecord: false,
	calendarId: "primary",
	exclusionKeywords: "",
	openMeetAutomatically: true,
	agendaLookAheadDays: 7,
	agendaLookBackDays: 7,
};

export class SystemRecordingSettingTab extends PluginSettingTab {
    plugin: SystemRecordingPlugin;

    constructor(app: App, plugin: SystemRecordingPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        const s = t();
        containerEl.empty();

        new Setting(containerEl)
            .setName(s.settings.recordingFolder.name)
            .setDesc(s.settings.recordingFolder.desc)
            .addText((text) =>
                text
                    .setPlaceholder(s.settings.recordingFolder.placeholder)
                    .setValue(this.plugin.settings.recordingFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.recordingFolder = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName(s.settings.fileNameTemplate.name)
            .setDesc(s.settings.fileNameTemplate.desc)
            .addText((text) =>
                text
                    .setValue(this.plugin.settings.fileNameTemplate)
                    .onChange(async (value) => {
                        this.plugin.settings.fileNameTemplate = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName(s.settings.meetingsFolder.name)
            .setDesc(s.settings.meetingsFolder.desc)
            .addText((text) =>
                text
                    .setPlaceholder(s.settings.meetingsFolder.placeholder)
                    .setValue(this.plugin.settings.meetingsFolder)
                    .onChange(async (value) => {
                        this.plugin.settings.meetingsFolder = value.trim() || "Meetings";
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName(s.settings.noteTitlePattern.name)
            .setDesc(s.settings.noteTitlePattern.desc)
            .addText((text) =>
                text
                    .setPlaceholder(DEFAULT_TITLE_PATTERN)
                    .setValue(this.plugin.settings.noteTitlePattern)
                    .onChange(async (value) => {
                        this.plugin.settings.noteTitlePattern =
                            value.trim() || DEFAULT_TITLE_PATTERN;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName(s.settings.noteTemplate.name)
            .setDesc(s.settings.noteTemplate.desc)
            .addTextArea((ta) => {
                ta.setValue(this.plugin.settings.noteTemplate).onChange(
                    async (value) => {
                        this.plugin.settings.noteTemplate =
                            value || DEFAULT_NOTE_TEMPLATE;
                        await this.plugin.saveSettings();
                    }
                );
                ta.inputEl.rows = 12;
                ta.inputEl.addClass("meeting-copilot-template-input");
            });

        new Setting(containerEl)
            .setName(s.settings.retentionDays.name)
            .setDesc(s.settings.retentionDays.desc)
            .addText((text) => {
                text.inputEl.type = "number";
                text
                    .setValue(String(this.plugin.settings.retentionDays))
                    .onChange(async (value) => {
                        const n = Number.parseInt(value, 10);
                        this.plugin.settings.retentionDays = Number.isFinite(n) && n >= 0 ? n : 0;
                        await this.plugin.saveSettings();
                    });
            });

		new Setting(containerEl).setName(s.settings.calendarHeading).setHeading();

		new Setting(containerEl)
			.setName(s.settings.clientId.name)
			.setDesc(s.settings.clientId.desc)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.googleClientId)
					.onChange(async (value) => {
						this.plugin.settings.googleClientId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.clientSecret.name)
			.setDesc(s.settings.clientSecret.desc)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setValue(this.plugin.settings.googleClientSecret)
					.onChange(async (value) => {
						this.plugin.settings.googleClientSecret = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(s.settings.googleAuth.name)
			.setDesc(
				this.plugin.isCalendarAuthenticated()
					? s.settings.googleAuth.descAuthenticated
					: s.settings.googleAuth.descUnauthenticated
			)
			.addButton((btn) =>
				btn
					.setButtonText(
						this.plugin.isCalendarAuthenticated()
							? s.settings.googleAuth.buttonReauthenticate
							: s.settings.googleAuth.buttonAuthenticate
					)
					.setCta()
					.onClick(async () => {
						await this.plugin.authenticateCalendar();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.calendarAutoRecord.name)
			.setDesc(s.settings.calendarAutoRecord.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.calendarAutoRecord)
					.onChange(async (value) => {
						this.plugin.settings.calendarAutoRecord = value;
						await this.plugin.saveSettings();
						this.plugin.updateScheduler();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.targetCalendarId.name)
			.setDesc(s.settings.targetCalendarId.desc)
			.addText((text) => {
				text
					.setValue(this.plugin.settings.calendarId)
					.onChange(async (value) => {
						this.plugin.settings.calendarId = value.trim() || "primary";
						await this.plugin.saveSettings();
					});
				// Re-poll immediately once the user finishes editing (avoids per-keystroke API calls).
				this.plugin.registerDomEvent(text.inputEl, "blur", () => {
					this.plugin.refreshCalendarNow();
				});
			});

		new Setting(containerEl)
			.setName(s.settings.exclusionKeywords.name)
			.setDesc(s.settings.exclusionKeywords.desc)
			.addTextArea((ta) => {
				ta
					.setValue(this.plugin.settings.exclusionKeywords)
					.onChange(async (value) => {
						this.plugin.settings.exclusionKeywords = value;
						await this.plugin.saveSettings();
					});
				// Re-poll and refresh the agenda once editing ends so newly
				// excluded events drop out without waiting for the next poll.
				this.plugin.registerDomEvent(ta.inputEl, "blur", () => {
					this.plugin.refreshCalendarNow();
					this.plugin.refreshAgenda();
				});
			});

		new Setting(containerEl)
			.setName(s.settings.openMeet.name)
			.setDesc(s.settings.openMeet.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.openMeetAutomatically)
					.onChange(async (value) => {
						this.plugin.settings.openMeetAutomatically = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.agendaLookAhead.name)
			.setDesc(s.settings.agendaLookAhead.desc)
			.addText((text) => {
				text.inputEl.type = "number";
				text
					.setValue(String(this.plugin.settings.agendaLookAheadDays))
					.onChange(async (value) => {
						const n = Number.parseInt(value, 10);
						this.plugin.settings.agendaLookAheadDays =
							Number.isFinite(n) && n >= 1 ? Math.min(n, 180) : 7;
						await this.plugin.saveSettings();
						this.plugin.refreshAgenda();
					});
			});

		new Setting(containerEl)
			.setName(s.settings.agendaLookBack.name)
			.setDesc(s.settings.agendaLookBack.desc)
			.addText((text) => {
				text.inputEl.type = "number";
				text
					.setValue(String(this.plugin.settings.agendaLookBackDays))
					.onChange(async (value) => {
						const n = Number.parseInt(value, 10);
						this.plugin.settings.agendaLookBackDays =
							Number.isFinite(n) && n >= 0 ? Math.min(n, 30) : 7;
						await this.plugin.saveSettings();
						this.plugin.refreshAgenda();
					});
			});
    }
}
