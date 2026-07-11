import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type SystemRecordingPlugin from "./main";
import type { StoredTokens } from "./auth/googleOAuth";
import {
	DEFAULT_NOTE_TEMPLATE,
	DEFAULT_TITLE_PATTERN,
} from "./notes/meetingNote";
import { DEFAULT_ENRICH_PROMPT } from "./enrich/prompt";
import { listModels } from "./enrich/models";
import { inferSttApiType, STT_MODELS, type SttApiType } from "./transcribe/sttModel";
import { t } from "./i18n";

export interface SystemRecordingSettings {
	recordingFolder: string;
	fileNameTemplate: string;
	/** `{{placeholder}}` folder template for one-off meetings, e.g. "Meetings/{{year}}". */
	oneOffFolderTemplate: string;
	/** `{{placeholder}}` folder template for a new recurring series, e.g. "Meetings/{{series}}". */
	seriesFolderTemplate: string;
	/** When on, 1:1s get their own per-person folder instead of following the series/one-off rules. */
	oneOnOneSeparately: boolean;
	/** Parent folder for a 1:1's per-person subfolder. */
	oneOnOneFolder: string;
	/** Folder for unplanned (ad-hoc) meetings. */
	adhocFolder: string;
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
	// Meeting detection (Tier 1, macOS).
	detectMeetings: boolean;
	detectZoom: boolean;
	detectGoogleMeet: boolean;
	detectionIntervalSeconds: number;
	agendaLookAheadDays: number;
	agendaLookBackDays: number;
	// Shared OpenAI-compatible endpoint + credentials (transcription + enrichment).
	apiBaseUrl: string;
	apiKey: string;
	// Transcription (vendored engine).
	/** Model id sent to the endpoint (e.g. gpt-4o-transcribe, or a gateway name like llm-gateway/whisper). */
	sttModel: string;
	/** Engine family the model speaks — drives routing/chunking and word timestamps. */
	sttApiType: SttApiType;
	sttLanguage: string;
	postProcessingEnabled: boolean;
	dictionaryCorrectionEnabled: boolean;
	/** Custom dictionary, one `misheard => correct` rule per line. Applied for all transcription languages. */
	dictionary: string;
	// Enrichment.
	enableEnrichment: boolean;
	enrichModel: string;
	enrichPrompt: string;
	enrichOnTranscribe: boolean;
	hideAiNotes: boolean;
	/** After enriching an ad-hoc meeting, ask the LLM for a title and offer to rename. */
	suggestAdhocTitle: boolean;
}

export { STT_MODELS, inferSttApiType, type SttApiType };

export const DEFAULT_SETTINGS: SystemRecordingSettings = {
	recordingFolder: "recordings",
	fileNameTemplate: "recording-YYYY-MM-DD-HHmmss",
	oneOffFolderTemplate: "Meetings/{{year}}",
	seriesFolderTemplate: "Meetings/{{series}}",
	oneOnOneSeparately: false,
	oneOnOneFolder: "Meetings/1-1s",
	adhocFolder: "Meetings/Ad-hoc",
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
	detectMeetings: true,
	detectZoom: true,
	detectGoogleMeet: false,
	detectionIntervalSeconds: 10,
	agendaLookAheadDays: 7,
	agendaLookBackDays: 7,
	apiBaseUrl: "https://api.openai.com/v1",
	apiKey: "",
	sttModel: "gpt-4o-transcribe",
	sttApiType: "gpt-4o-transcribe",
	sttLanguage: "auto",
	postProcessingEnabled: false,
	dictionaryCorrectionEnabled: false,
	dictionary: "",
	enableEnrichment: true,
	enrichModel: "gpt-4o",
	enrichPrompt: DEFAULT_ENRICH_PROMPT,
	enrichOnTranscribe: true,
	hideAiNotes: false,
	suggestAdhocTitle: true,
};

/**
 * Migrates settings loaded from disk. A vault that predates the folder
 * templates had a single `meetingsFolder` string; that string becomes the
 * root for both the one-off and (new) series templates so an existing note
 * layout doesn't move. Pure so it can run without a vault. `loaded` is
 * untyped since the legacy `meetingsFolder` key no longer exists on
 * `SystemRecordingSettings`.
 */
export function migrateSettings(
	loaded: Record<string, unknown> | null
): Partial<SystemRecordingSettings> {
	if (!loaded) return {};
	if (loaded["oneOffFolderTemplate"] !== undefined) {
		return loaded as Partial<SystemRecordingSettings>;
	}
	const legacyFolder = loaded["meetingsFolder"];
	const base = typeof legacyFolder === "string" && legacyFolder ? legacyFolder : "Meetings";
	return {
		...(loaded as Partial<SystemRecordingSettings>),
		oneOffFolderTemplate: base,
		seriesFolderTemplate: `${base}/{{series}}`,
	};
}

export class SystemRecordingSettingTab extends PluginSettingTab {
    plugin: SystemRecordingPlugin;
    /** Model ids fetched from the endpoint (populated by "Test connection"), shared by transcription + enrichment. */
    private models: string[] = [];

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

		// ---- Meeting detection (macOS) ----
		new Setting(containerEl)
			.setName(s.settings.detectionHeading)
			.setHeading();

		new Setting(containerEl)
			.setName(s.settings.detectMeetings.name)
			.setDesc(s.settings.detectMeetings.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.detectMeetings)
					.onChange(async (value) => {
						this.plugin.settings.detectMeetings = value;
						await this.plugin.saveSettings();
						this.plugin.updateDetector();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.detectZoom.name)
			.setDesc(s.settings.detectZoom.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.detectZoom)
					.onChange(async (value) => {
						this.plugin.settings.detectZoom = value;
						await this.plugin.saveSettings();
						this.plugin.updateDetector();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.detectGoogleMeet.name)
			.setDesc(s.settings.detectGoogleMeet.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.detectGoogleMeet)
					.onChange(async (value) => {
						this.plugin.settings.detectGoogleMeet = value;
						await this.plugin.saveSettings();
						this.plugin.updateDetector();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.detectionInterval.name)
			.setDesc(s.settings.detectionInterval.desc)
			.addText((text) => {
				text.inputEl.type = "number";
				text
					.setValue(
						String(this.plugin.settings.detectionIntervalSeconds)
					)
					.onChange(async (value) => {
						const n = Number.parseInt(value, 10);
						this.plugin.settings.detectionIntervalSeconds =
							Number.isFinite(n) && n >= 3 ? Math.min(n, 120) : 10;
						await this.plugin.saveSettings();
						this.plugin.updateDetector();
					});
			});

		// ---- AI ----
		// One endpoint + key is used for both transcription and enrichment.
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
			})
			.addButton((button) =>
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
							this.models = await listModels(apiBaseUrl, apiKey);
							new Notice(
								this.models.length === 0
									? s.settings.testConnection.empty
									: s.settings.testConnection.success(
											this.models.length
										)
							);
							// Re-render so both model dropdowns pick up the list.
							this.display();
						} catch (e) {
							new Notice(
								s.settings.testConnection.failure(
									e instanceof Error ? e.message : String(e)
								)
							);
							button.setButtonText(
								s.settings.testConnection.button
							);
							button.setDisabled(false);
						}
					})
			);

		// ---- Transcription ----
		new Setting(containerEl)
			.setName(s.settings.transcriptionHeading)
			.setHeading();

		// Model id sent on the wire (dropdown once models are loaded, else free text).
		this.addModelPicker(
			new Setting(containerEl)
				.setName(s.settings.sttModel.name)
				.setDesc(s.settings.sttModel.desc),
			this.plugin.settings.sttModel,
			async (value) => {
				this.plugin.settings.sttModel = value;
				// Keep the engine family in sync with the picked model.
				this.plugin.settings.sttApiType = inferSttApiType(value);
				await this.plugin.saveSettings();
				this.display();
			}
		);

		new Setting(containerEl)
			.setName(s.settings.sttApiType.name)
			.setDesc(s.settings.sttApiType.desc)
			.addDropdown((dd) => {
				dd.addOption(
					"gpt-4o-transcribe",
					s.settings.sttApiType.gpt4o
				);
				dd.addOption(
					"gpt-4o-mini-transcribe",
					s.settings.sttApiType.gpt4oMini
				);
				dd.addOption("whisper-1", s.settings.sttApiType.whisper);
				dd.addOption(
					"whisper-1-ts",
					s.settings.sttApiType.whisperTs
				);
				dd.setValue(this.plugin.settings.sttApiType).onChange(
					async (value) => {
						this.plugin.settings.sttApiType = STT_MODELS.includes(
							value as SttApiType
						)
							? (value as SttApiType)
							: "gpt-4o-transcribe";
						await this.plugin.saveSettings();
					}
				);
			});

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
				ta.inputEl.rows = 8;
				ta.inputEl.addClass("meeting-copilot-template-input");
			});

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

		this.addModelPicker(
			new Setting(containerEl)
				.setName(s.settings.enrichModel.name)
				.setDesc(s.settings.enrichModel.desc),
			this.plugin.settings.enrichModel,
			async (value) => {
				this.plugin.settings.enrichModel = value;
				await this.plugin.saveSettings();
			}
		);

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
				ta.inputEl.rows = 18;
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

		new Setting(containerEl)
			.setName(s.settings.suggestAdhocTitle.name)
			.setDesc(s.settings.suggestAdhocTitle.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.suggestAdhocTitle)
					.onChange(async (value) => {
						this.plugin.settings.suggestAdhocTitle = value;
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
			.setName(s.settings.oneOffFolderTemplate.name)
			.setDesc(s.settings.oneOffFolderTemplate.desc)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.oneOffFolderTemplate)
					.setValue(this.plugin.settings.oneOffFolderTemplate)
					.onChange(async (value) => {
						this.plugin.settings.oneOffFolderTemplate =
							value.trim() || DEFAULT_SETTINGS.oneOffFolderTemplate;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.seriesFolderTemplate.name)
			.setDesc(s.settings.seriesFolderTemplate.desc)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.seriesFolderTemplate)
					.setValue(this.plugin.settings.seriesFolderTemplate)
					.onChange(async (value) => {
						this.plugin.settings.seriesFolderTemplate =
							value.trim() || DEFAULT_SETTINGS.seriesFolderTemplate;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.adhocFolder.name)
			.setDesc(s.settings.adhocFolder.desc)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.adhocFolder)
					.setValue(this.plugin.settings.adhocFolder)
					.onChange(async (value) => {
						this.plugin.settings.adhocFolder =
							value.trim() || DEFAULT_SETTINGS.adhocFolder;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.oneOnOneSeparately.name)
			.setDesc(s.settings.oneOnOneSeparately.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.oneOnOneSeparately)
					.onChange(async (value) => {
						this.plugin.settings.oneOnOneSeparately = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.oneOnOneFolder.name)
			.setDesc(s.settings.oneOnOneFolder.desc)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.oneOnOneFolder)
					.setValue(this.plugin.settings.oneOnOneFolder)
					.onChange(async (value) => {
						this.plugin.settings.oneOnOneFolder =
							value.trim() || DEFAULT_SETTINGS.oneOnOneFolder;
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
				ta.inputEl.rows = 18;
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
     * Model picker used by both transcription and enrichment. Shows a dropdown
     * of the models fetched from the endpoint (via "Test connection"), keeping
     * the current value selectable even if the endpoint didn't list it. Falls
     * back to a free-text field when no models have been loaded yet so the user
     * can still type a model id offline.
     */
    private addModelPicker(
        setting: Setting,
        current: string,
        onChange: (value: string) => Promise<void>
    ): void {
        if (this.models.length > 0) {
            const options: Record<string, string> = {};
            for (const m of this.models) options[m] = m;
            if (current && !options[current]) options[current] = current;
            setting.addDropdown((dd) =>
                dd
                    .addOptions(options)
                    .setValue(current)
                    .onChange(async (value) => {
                        await onChange(value);
                    })
            );
        } else {
            setting.addText((text) =>
                text.setValue(current).onChange(async (value) => {
                    await onChange(value.trim());
                })
            );
        }
    }
}
