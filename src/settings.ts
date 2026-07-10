import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import SystemRecordingPlugin from "./main";
import type { StoredTokens } from "./auth/googleOAuth";
import {
	DEFAULT_NOTE_TEMPLATE,
	DEFAULT_TITLE_PATTERN,
} from "./notes/meetingNote";
import { DEFAULT_ENRICH_PROMPT } from "./enrich/prompt";
import { listModels } from "./enrich/models";
import { t } from "./i18n";

export interface SystemRecordingSettings {
	recordingFolder: string;
	fileNameTemplate: string;
	meetingsFolder: string;
	noteTitlePattern: string;
	noteTemplate: string;
	retentionDays: number;
	insertTranscript: boolean;
	autoTranscribe: boolean;
	actionItemsAsTasks: boolean;
	googleClientId: string;
	googleClientSecret: string;
	googleTokens: StoredTokens | null;
	calendarAutoRecord: boolean;
	calendarId: string;
	exclusionKeywords: string;
	openMeetAutomatically: boolean;
	agendaLookAheadDays: number;
	agendaLookBackDays: number;
	// Shared OpenAI-compatible endpoint + credentials (transcription + enrichment).
	apiBaseUrl: string;
	apiKey: string;
	// Transcription (vendored engine).
	sttModel: string;
	/** Custom deployment name to send instead of the canonical model id (e.g. LiteLLM `llm-gateway/whisper`). */
	sttModelId: string;
	sttLanguage: string;
	vadMode: "server" | "disabled";
	postProcessingEnabled: boolean;
	dictionaryCorrectionEnabled: boolean;
	/** Custom dictionary, one `misheard => correct` rule per line (English). */
	dictionary: string;
	// Enrichment.
	enableEnrichment: boolean;
	enrichModel: string;
	enrichPrompt: string;
	enrichOnTranscribe: boolean;
	hideAiNotes: boolean;
}

/** Transcription models the vendored engine understands (routes Whisper vs GPT-4o). */
export const STT_MODELS = [
	"gpt-4o-transcribe",
	"gpt-4o-mini-transcribe",
	"whisper-1",
	"whisper-1-ts",
] as const;

export const DEFAULT_SETTINGS: SystemRecordingSettings = {
	recordingFolder: "recordings",
	fileNameTemplate: "recording-YYYY-MM-DD-HHmmss",
	meetingsFolder: "Meetings",
	noteTitlePattern: DEFAULT_TITLE_PATTERN,
	noteTemplate: DEFAULT_NOTE_TEMPLATE,
	retentionDays: 90,
	insertTranscript: true,
	autoTranscribe: true,
	actionItemsAsTasks: true,
	googleClientId: "",
	googleClientSecret: "",
	googleTokens: null,
	calendarAutoRecord: false,
	calendarId: "primary",
	exclusionKeywords: "",
	openMeetAutomatically: true,
	agendaLookAheadDays: 7,
	agendaLookBackDays: 7,
	apiBaseUrl: "https://api.openai.com/v1",
	apiKey: "",
	sttModel: "gpt-4o-transcribe",
	sttModelId: "",
	sttLanguage: "auto",
	vadMode: "server",
	postProcessingEnabled: false,
	dictionaryCorrectionEnabled: false,
	dictionary: "",
	enableEnrichment: true,
	enrichModel: "gpt-4o",
	enrichPrompt: DEFAULT_ENRICH_PROMPT,
	enrichOnTranscribe: true,
	hideAiNotes: false,
};

export class SystemRecordingSettingTab extends PluginSettingTab {
    plugin: SystemRecordingPlugin;
    /** Model ids fetched from the endpoint (populated by "Test connection"). */
    private enrichModels: string[] = [];

    constructor(app: App, plugin: SystemRecordingPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        const s = t();
        containerEl.empty();

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

		// ---- AI endpoint (shared by transcription + enrichment) ----
		new Setting(containerEl).setName(s.settings.endpointHeading).setHeading();

		new Setting(containerEl)
			.setName(s.settings.apiBaseUrl.name)
			.setDesc(s.settings.apiBaseUrl.desc)
			.addText((text) =>
				text
					.setPlaceholder("https://api.openai.com/v1")
					.setValue(this.plugin.settings.apiBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.apiBaseUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.apiKey.name)
			.setDesc(s.settings.apiKey.desc)
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		// ---- Transcription ----
		new Setting(containerEl)
			.setName(s.settings.transcriptionHeading)
			.setHeading();

		new Setting(containerEl)
			.setName(s.settings.sttModel.name)
			.setDesc(s.settings.sttModel.desc)
			.addDropdown((dd) => {
				for (const m of STT_MODELS) dd.addOption(m, m);
				dd.setValue(this.plugin.settings.sttModel).onChange(
					async (value) => {
						this.plugin.settings.sttModel = value;
						await this.plugin.saveSettings();
					}
				);
			});

		new Setting(containerEl)
			.setName(s.settings.sttModelId.name)
			.setDesc(s.settings.sttModelId.desc)
			.addText((text) =>
				text
					.setPlaceholder(s.settings.sttModelId.placeholder)
					.setValue(this.plugin.settings.sttModelId)
					.onChange(async (value) => {
						this.plugin.settings.sttModelId = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.sttLanguage.name)
			.setDesc(s.settings.sttLanguage.desc)
			.addText((text) =>
				text
					.setPlaceholder("Auto-detect")
					.setValue(this.plugin.settings.sttLanguage)
					.onChange(async (value) => {
						this.plugin.settings.sttLanguage =
							value.trim() || "auto";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.vadMode.name)
			.setDesc(s.settings.vadMode.desc)
			.addDropdown((dd) =>
				dd
					.addOption("server", s.settings.vadMode.server)
					.addOption("disabled", s.settings.vadMode.disabled)
					.setValue(this.plugin.settings.vadMode)
					.onChange(async (value) => {
						this.plugin.settings.vadMode =
							value === "disabled" ? "disabled" : "server";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.postProcessing.name)
			.setDesc(s.settings.postProcessing.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.postProcessingEnabled)
					.onChange(async (value) => {
						this.plugin.settings.postProcessingEnabled = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.dictionaryCorrection.name)
			.setDesc(s.settings.dictionaryCorrection.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.dictionaryCorrectionEnabled)
					.onChange(async (value) => {
						this.plugin.settings.dictionaryCorrectionEnabled = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.dictionary.name)
			.setDesc(s.settings.dictionary.desc)
			.addTextArea((ta) => {
				ta
					.setPlaceholder(s.settings.dictionary.placeholder)
					.setValue(this.plugin.settings.dictionary)
					.onChange(async (value) => {
						this.plugin.settings.dictionary = value;
						await this.plugin.saveSettings();
					});
				ta.inputEl.rows = 4;
				ta.inputEl.addClass("meeting-copilot-template-input");
			});

		new Setting(containerEl)
			.setName(s.settings.autoTranscribe.name)
			.setDesc(s.settings.autoTranscribe.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoTranscribe)
					.onChange(async (value) => {
						this.plugin.settings.autoTranscribe = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.insertTranscript.name)
			.setDesc(s.settings.insertTranscript.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.insertTranscript)
					.onChange(async (value) => {
						this.plugin.settings.insertTranscript = value;
						await this.plugin.saveSettings();
					})
			);

		// ---- AI enrichment ----
		new Setting(containerEl).setName(s.settings.enrichHeading).setHeading();

		new Setting(containerEl)
			.setName(s.settings.enableEnrichment.name)
			.setDesc(s.settings.enableEnrichment.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableEnrichment)
					.onChange(async (value) => {
						this.plugin.settings.enableEnrichment = value;
						await this.plugin.saveSettings();
					})
			);

		this.renderEnrichModelSetting(containerEl);

		new Setting(containerEl)
			.setName(s.settings.enrichOnTranscribe.name)
			.setDesc(s.settings.enrichOnTranscribe.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enrichOnTranscribe)
					.onChange(async (value) => {
						this.plugin.settings.enrichOnTranscribe = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.enrichPrompt.name)
			.setDesc(s.settings.enrichPrompt.desc)
			.addTextArea((ta) => {
				ta.setValue(this.plugin.settings.enrichPrompt).onChange(
					async (value) => {
						this.plugin.settings.enrichPrompt =
							value || DEFAULT_ENRICH_PROMPT;
						await this.plugin.saveSettings();
					}
				);
				ta.inputEl.addClass("meeting-copilot-template-input");
			});

		new Setting(containerEl)
			.setName(s.settings.actionItemsAsTasks.name)
			.setDesc(s.settings.actionItemsAsTasks.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.actionItemsAsTasks)
					.onChange(async (value) => {
						this.plugin.settings.actionItemsAsTasks = value;
						await this.plugin.saveSettings();
					})
			);

		// ---- Recording & notes ----
		new Setting(containerEl)
			.setName(s.settings.recordingHeading)
			.setHeading();

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
						this.plugin.settings.meetingsFolder =
							value.trim() || "Meetings";
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
						this.plugin.settings.retentionDays =
							Number.isFinite(n) && n >= 0 ? n : 0;
						await this.plugin.saveSettings();
					});
			});
    }

    /**
     * Model picker for enrichment. Shows a dropdown once models have been
     * fetched from the endpoint, otherwise a free-text field so the user can
     * type a model id even while offline. A "Test connection" button doubles as
     * "load models".
     */
    private renderEnrichModelSetting(containerEl: HTMLElement): void {
        const s = t();
        const setting = new Setting(containerEl)
            .setName(s.settings.enrichModel.name)
            .setDesc(s.settings.enrichModel.desc);

        const current = this.plugin.settings.enrichModel;
        if (this.enrichModels.length > 0) {
            const options: Record<string, string> = {};
            for (const m of this.enrichModels) options[m] = m;
            // Keep the current value selectable even if the endpoint didn't list it.
            if (current && !options[current]) options[current] = current;
            setting.addDropdown((dd) =>
                dd
                    .addOptions(options)
                    .setValue(current)
                    .onChange(async (value) => {
                        this.plugin.settings.enrichModel = value;
                        await this.plugin.saveSettings();
                    })
            );
        } else {
            setting.addText((text) =>
                text.setValue(current).onChange(async (value) => {
                    this.plugin.settings.enrichModel = value.trim();
                    await this.plugin.saveSettings();
                })
            );
        }

        setting.addButton((button) =>
            button
                .setButtonText(s.settings.testConnection.button)
                .onClick(async () => {
                    const { apiBaseUrl, apiKey } = this.plugin.settings;
                    if (!apiBaseUrl) {
                        new Notice(s.settings.testConnection.noBaseUrl);
                        return;
                    }
                    button.setButtonText(s.settings.testConnection.testing);
                    button.setDisabled(true);
                    try {
                        this.enrichModels = await listModels(
                            apiBaseUrl,
                            apiKey
                        );
                        new Notice(
                            this.enrichModels.length === 0
                                ? s.settings.testConnection.empty
                                : s.settings.testConnection.success(
                                      this.enrichModels.length
                                  )
                        );
                        this.display();
                    } catch (e) {
                        new Notice(
                            s.settings.testConnection.failure(
                                e instanceof Error ? e.message : String(e)
                            )
                        );
                        button.setButtonText(s.settings.testConnection.button);
                        button.setDisabled(false);
                    }
                })
        );
    }
}
