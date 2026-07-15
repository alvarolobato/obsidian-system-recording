import {
	App,
	DropdownComponent,
	Notice,
	PluginSettingTab,
	Setting,
} from "obsidian";
import type SystemRecordingPlugin from "./main";
import type { InputDevice } from "./recorder";
import type { StoredTokens } from "./auth/googleOAuth";
import {
	DEFAULT_NOTE_TEMPLATE,
	DEFAULT_TITLE_PATTERN,
} from "./notes/meetingNote";
import { DEFAULT_ENRICH_PROMPT } from "./enrich/prompt";
import { listModels } from "./enrich/models";
import {
	inferSttApiType,
	isTimestampCapableFamily,
	STT_MODELS,
	type SttApiType,
} from "./transcribe/sttModel";
import { probeKey, probeSttSupport } from "./transcribe/probe";
import {
	fetchModelCapabilities,
	type ModelCapability,
} from "./transcribe/capabilities";
import {
	DEFAULT_LOCAL_MODEL_ID,
	LOCAL_MODELS,
	formatBytes,
	localModelSpec,
} from "./transcribe/localModels";
import { t, type Messages } from "./i18n";

export interface SystemRecordingSettings {
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
	/**
	 * Subfolder (relative to a note's own folder) where that note's recordings
	 * and their split sidecars are written, e.g. "Recordings" puts a note at
	 * `Meetings/x.md`'s audio under `Meetings/Recordings/`. Empty = colocate the
	 * audio beside the note (the pre-0.2 behavior).
	 */
	recordingSubfolder: string;
	/**
	 * Save recordings (and their split sidecars) as AAC `.m4a` instead of WAV.
	 * Same mono 24 kHz audio either way; this only picks the container/codec
	 * the helper encodes at stop.
	 */
	compressedRecordings: boolean;
	/**
	 * Stable UID of the input device (microphone) to record the "Me" channel
	 * from. Empty = the system default input. A UID that no longer resolves at
	 * record time falls back to the default with a notice.
	 */
	micDeviceUid: string;
	/**
	 * Friendly name of {@link micDeviceUid}, remembered so the "device
	 * unavailable" notice can name it even after the device is unplugged (the
	 * helper only ever sees the UID).
	 */
	micDeviceLabel: string;
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
	/**
	 * Automatically start recording at a calendar event's start, instead of only
	 * prompting. Opt-in; pairs with `calendarAutoStop`.
	 */
	calendarAutoStart: boolean;
	/** Automatically stop a calendar recording when the event ends (opt-in). */
	calendarAutoStop: boolean;
	/**
	 * How many minutes before an event's start to fire the "meeting is about to
	 * start" notification. 0 disables the pre-start notification (you're still
	 * prompted at the start itself).
	 */
	notifyBeforeStartMinutes: number;
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
	// Transcription backend selection (issue #34).
	/** Where audio is transcribed: the remote OpenAI-compatible endpoint, or a local on-device Whisper model. */
	transcriptionBackend: "remote" | "local";
	/** Local ggml model id (see {@link LOCAL_MODELS}) used when `transcriptionBackend` is "local". */
	localWhisperModel: string;
	/** When local transcription fails, fall back to the remote endpoint if one is configured. */
	localFallbackToRemote: boolean;
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
	/** Transcribe mic and system audio separately so each speaker's side can be told apart. Needs a timestamp-capable model. */
	diarizationEnabled: boolean;
	/** Whether the selected model can transcribe at all (from endpoint capabilities or a probe). null = not yet determined, or invalidated by a config change. */
	sttTranscriptionSupported: boolean | null;
	/** Whether the configured endpoint actually returns segment timestamps. null = never probed, or invalidated by a later config change. */
	sttTimestampsSupported: boolean | null;
	/** Verbose transcription logging (per-chunk timing, rate-limit waits, retries) to the developer console. Off by default. */
	debugLogging: boolean;
	/** The `${apiBaseUrl}::${sttModel}` the two flags above were determined against; a mismatch means they're stale. */
	sttTimestampsProbeKey: string;
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

/** Shared row count so every settings text area is the same (comfortable) height. */
const TEXTAREA_ROWS = 18;

export const DEFAULT_SETTINGS: SystemRecordingSettings = {
	oneOffFolderTemplate: "Meetings/{{year}}",
	seriesFolderTemplate: "Meetings/{{series}}",
	oneOnOneSeparately: true,
	oneOnOneFolder: "Meetings/1-1s",
	adhocFolder: "Meetings/Ad-hoc",
	recordingSubfolder: "Recordings",
	compressedRecordings: true,
	micDeviceUid: "",
	micDeviceLabel: "",
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
	calendarAutoStart: false,
	calendarAutoStop: false,
	notifyBeforeStartMinutes: 1,
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
	transcriptionBackend: "remote",
	localWhisperModel: DEFAULT_LOCAL_MODEL_ID,
	localFallbackToRemote: false,
	sttModel: "gpt-4o-transcribe",
	sttApiType: "gpt-4o-transcribe",
	sttLanguage: "auto",
	postProcessingEnabled: false,
	dictionaryCorrectionEnabled: false,
	dictionary: "",
	// Off by default: diarization runs two full transcription passes (~2x the
	// time of the mixed path) and speaker separation is still being hardened.
	// Turn it on per-vault to get me/them labels; local WebRTC VAD then gates
	// each stream's silence and cross-talk bleed is de-duped so the merge stays
	// clean. Manual re-transcribe can also force it on/off per run.
	diarizationEnabled: false,
	sttTranscriptionSupported: null,
	sttTimestampsSupported: null,
	sttTimestampsProbeKey: "",
	debugLogging: false,
	enableEnrichment: true,
	enrichModel: "gpt-4o",
	enrichPrompt: DEFAULT_ENRICH_PROMPT,
	enrichOnTranscribe: true,
	hideAiNotes: false,
	suggestAdhocTitle: true,
};

/** Folder-template keys that must be a non-empty string, or `DEFAULT_SETTINGS` wins instead. */
const FOLDER_TEMPLATE_KEYS = [
	"oneOffFolderTemplate",
	"seriesFolderTemplate",
	"oneOnOneFolder",
	"adhocFolder",
] as const;

/**
 * Drops any of the folder-template keys (or `oneOnOneSeparately`) that are
 * present but hold the wrong type, so a hand-edited or corrupted `data.json`
 * (e.g. `oneOffFolderTemplate: null`) can't pass a bad value through
 * `Object.assign` and crash every folder-resolution path that calls
 * `.replace` on it. Leaving the key out entirely lets `DEFAULT_SETTINGS` win.
 */
function sanitizeMigrated(
	result: Partial<SystemRecordingSettings>
): Partial<SystemRecordingSettings> {
	const out = { ...result } as Record<string, unknown>;
	for (const key of FOLDER_TEMPLATE_KEYS) {
		if (key in out && (typeof out[key] !== "string" || out[key] === "")) {
			delete out[key];
		}
	}
	if ("oneOnOneSeparately" in out && typeof out["oneOnOneSeparately"] !== "boolean") {
		delete out["oneOnOneSeparately"];
	}
	return out as Partial<SystemRecordingSettings>;
}

/**
 * Migrates settings loaded from disk. A vault that predates the folder
 * templates had a single `meetingsFolder` string; that string becomes the
 * root for both the one-off and (new) series templates so an existing note
 * layout doesn't move. Pure so it can run without a vault. `loaded` is
 * untyped since the legacy `meetingsFolder` key no longer exists on
 * `SystemRecordingSettings`, and since a hand-edited file may carry any type
 * at all for keys that `sanitizeMigrated` then validates.
 */
export function migrateSettings(
	loaded: Record<string, unknown> | null
): Partial<SystemRecordingSettings> {
	if (!loaded) return {};
	if (loaded["oneOffFolderTemplate"] !== undefined) {
		return sanitizeMigrated(loaded as Partial<SystemRecordingSettings>);
	}
	const legacyFolder = loaded["meetingsFolder"];
	const base = typeof legacyFolder === "string" && legacyFolder ? legacyFolder : "Meetings";
	return sanitizeMigrated({
		...(loaded as Partial<SystemRecordingSettings>),
		oneOffFolderTemplate: base,
		seriesFolderTemplate: `${base}/{{series}}`,
		// Nest ad-hoc notes under an "Ad-hoc" subfolder of the legacy folder,
		// matching the new default and the sibling `1-1s` nesting, rather than
		// dropping them loose alongside scheduled meetings.
		adhocFolder: `${base}/Ad-hoc`,
		oneOnOneFolder: `${base}/1-1s`,
	});
}

export class SystemRecordingSettingTab extends PluginSettingTab {
    plugin: SystemRecordingPlugin;
    /** Model ids fetched from the endpoint (populated by "Load models"), shared by transcription + enrichment. */
    private models: string[] = [];
    /** Per-model capabilities from the endpoint (LiteLLM), or null when the endpoint doesn't expose them (plain OpenAI). Drives the transcription-model filter. */
    private capabilities: Map<string, ModelCapability> | null = null;
    /** The `${baseUrl}::${model}` key currently being auto-assessed, so the badges can show "checking…". */
    private probingKey: string | null = null;
    /** Endpoint+model keys already auto-assessed this session, so re-renders don't re-fire the probe (even after an "unknown" result). */
    private probedKeys = new Set<string>();
    /** Description elements for the two STT support badges, updated in place so selecting a model doesn't re-render (and scroll-jump) the whole tab. */
    private sttTranscriptionBadgeEl: HTMLElement | null = null;
    private sttTimestampBadgeEl: HTMLElement | null = null;
    /** The engine-family dropdown, so a model change can update its value in place. */
    private sttEngineDropdown: DropdownComponent | null = null;
    /** Input devices last enumerated from the helper, for the Microphone picker. Empty until listed. */
    private inputDevices: InputDevice[] = [];
    /** True while a device enumeration is in flight, so the button can show progress and re-entry is blocked. */
    private listingDevices = false;
    /** True while a local model download is streaming, so the row shows progress and re-entry is blocked. */
    private downloadingModel = false;
    /** Whole-percent progress of the in-flight local model download (0–100). */
    private downloadProgress = 0;
    /** The on-screen local-model download/status row, updated in place during a download. */
    private modelDownloadRow: Setting | null = null;

    constructor(app: App, plugin: SystemRecordingPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        const s = t();
        containerEl.empty();
        containerEl.addClass("meeting-copilot-settings");
        // Opening (or re-rendering) the tab is a fresh chance to auto-probe:
        // clear the per-session "already probed" guard so a verdict invalidated
        // at runtime (e.g. diarization found no timestamps) is re-checked here
        // instead of being stuck at "not checked yet" until a manual Recheck.
        // The guard still prevents repeated probes from rapid in-tab edits.
        this.probedKeys.clear();

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
			.setName(s.settings.notifyBeforeStart.name)
			.setDesc(s.settings.notifyBeforeStart.desc)
			.addText((text) => {
				text.inputEl.type = "number";
				text
					.setValue(
						String(this.plugin.settings.notifyBeforeStartMinutes)
					)
					.onChange(async (value) => {
						const n = Number.parseInt(value, 10);
						this.plugin.settings.notifyBeforeStartMinutes =
							Number.isFinite(n) && n >= 0 ? Math.min(n, 60) : 1;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName(s.settings.calendarAutoStart.name)
			.setDesc(s.settings.calendarAutoStart.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.calendarAutoStart)
					.onChange(async (value) => {
						this.plugin.settings.calendarAutoStart = value;
						await this.plugin.saveSettings();
						this.plugin.updateScheduler();
					})
			);

		new Setting(containerEl)
			.setName(s.settings.calendarAutoStop.name)
			.setDesc(s.settings.calendarAutoStop.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.calendarAutoStop)
					.onChange(async (value) => {
						this.plugin.settings.calendarAutoStop = value;
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
				ta.inputEl.rows = TEXTAREA_ROWS;
				ta.inputEl.addClass("meeting-copilot-template-input");
				// Re-poll and refresh the agenda once editing ends so newly
				// excluded events drop out without waiting for the next poll.
				this.plugin.registerDomEvent(ta.inputEl, "blur", () => {
					this.plugin.refreshCalendarNow();
					this.plugin.refreshAgenda();
				});
			});

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

		this.renderRecordingSettings(containerEl);

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
						// The stored verdict is keyed on the old base URL, so the
						// badges now read "not checked yet"; repaint them and let
						// a re-probe run on the next model change / tab reopen.
						this.probedKeys.clear();
						this.refreshSttBadges();
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
						// probeKey ignores the key, so a stored verdict would
						// otherwise stay falsely "fresh" after a key change.
						// Reset it so transcription/timestamp support is
						// re-probed against the new credential.
						this.plugin.settings.sttTimestampsProbeKey = "";
						await this.plugin.saveSettings();
						this.probedKeys.clear();
						this.refreshSttBadges();
					});
			});

		// Endpoint actions: one button that verifies the endpoint and loads the
		// shared model list + capabilities used by both the transcription and
		// enrichment pickers. Kept as the last row of the endpoint section so
		// the credentials sit above it.
		new Setting(containerEl)
			.setName(s.settings.endpointActions.name)
			.setDesc(s.settings.endpointActions.desc)
			.addButton((button) =>
				button
					.setButtonText(s.settings.testConnection.button)
					.setCta()
					.onClick(async () => {
						const { apiBaseUrl, apiKey } = this.plugin.settings;
						if (!apiBaseUrl) {
							new Notice(s.settings.testConnection.noBaseUrl);
							return;
						}
						button.setButtonText(s.settings.testConnection.testing);
						button.setDisabled(true);
						try {
							// One round-trip: fetch the model list and, when the
							// endpoint exposes them (LiteLLM), per-model
							// capabilities so the STT picker can filter to real
							// transcription models.
							this.models = await listModels(apiBaseUrl, apiKey);
							this.capabilities = await fetchModelCapabilities(
								apiBaseUrl,
								apiKey
							);
							new Notice(
								this.models.length === 0
									? s.settings.testConnection.empty
									: s.settings.testConnection.success(
											this.models.length
										)
							);
							// Transcription/timestamp support is assessed
							// automatically when the model changes (and on open),
							// not here — this button only verifies the endpoint
							// and loads the model list + capabilities.
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

		// Engine selector: the remote OpenAI-compatible endpoint vs. an
		// on-device Whisper model (issue #34). Switching re-renders the section
		// so only the chosen engine's rows show.
		new Setting(containerEl)
			.setName(s.settings.transcriptionEngine.name)
			.setDesc(s.settings.transcriptionEngine.desc)
			.addDropdown((dd) => {
				dd.addOption("remote", s.settings.transcriptionEngine.remote);
				dd.addOption("local", s.settings.transcriptionEngine.local);
				dd
					.setValue(this.plugin.settings.transcriptionBackend)
					// Locked mid-download so the switch can't strand an in-flight
					// model fetch on a torn-down row.
					.setDisabled(this.downloadingModel)
					.onChange(async (value) => {
						this.plugin.settings.transcriptionBackend =
							value === "local" ? "local" : "remote";
						await this.plugin.saveSettings();
						this.display();
					});
			});

		// Layout preserves the pre-#34 remote order (engine identity → speaker
		// separation + language → dictionary → automation); the local rows slot
		// into the engine-identity position and the remote-only dictionary rows
		// are simply absent under Local.
		if (this.plugin.settings.transcriptionBackend === "local") {
			this.renderLocalTranscription(containerEl);
		} else {
			this.renderRemoteTranscription(containerEl);
		}
		this.renderDiarizationLanguage(containerEl);
		if (this.plugin.settings.transcriptionBackend !== "local") {
			this.renderRemoteDictionary(containerEl);
		}
		this.renderTranscriptionAutomation(containerEl);

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
				ta.inputEl.rows = TEXTAREA_ROWS;
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

    }

    /**
     * The remote (OpenAI-compatible endpoint) transcription rows: model picker,
     * support badges, engine-family override, and the dictionary/GPT-correction
     * options that only the vendored engine's pipeline applies.
     */
    private renderRemoteTranscription(containerEl: HTMLElement): void {
        const s = t();
        // Model id sent on the wire (dropdown once models are loaded, else free
        // text). Use "Load models" in the AI endpoint section above to
        // populate the list.
        const sttModelSetting = new Setting(containerEl)
            .setName(s.settings.sttModel.name)
            .setDesc(s.settings.sttModel.desc);
        this.addModelPicker(
            sttModelSetting,
            this.plugin.settings.sttModel,
            async (value) => {
                this.plugin.settings.sttModel = value;
                // Keep the engine family in sync with the picked model.
                this.plugin.settings.sttApiType = inferSttApiType(value);
                await this.plugin.saveSettings();
                // Update in place instead of re-rendering the whole tab (which
                // would scroll-jump back to the top): sync the engine dropdown,
                // refresh the badges, and kick off an assessment of the new
                // model.
                this.sttEngineDropdown?.setValue(this.engineDropdownValue());
                this.refreshSttBadges();
                this.maybeAssessSttModel();
            },
            // When the endpoint reports capabilities (LiteLLM), only offer
            // models it says can transcribe. Without that info (plain OpenAI),
            // no filter — the probe below determines transcription support.
            this.capabilities
                ? (id) => this.capabilities?.get(id)?.transcription === true
                : undefined
        );

        // Transcription support, with timestamp support shown as a sub-detail
        // beneath it (it only matters for speaker separation). Both lines live
        // in this one setting's description and are refreshed in place.
        const supportSetting = new Setting(containerEl)
            .setName(s.settings.transcriptionBadge.name)
            .addButton((button) =>
                button
                    .setButtonText(s.settings.recheckSupport.button)
                    .setTooltip(s.settings.recheckSupport.tooltip)
                    .onClick(() => this.recheckSttSupport())
            );
        supportSetting.descEl.empty();
        this.sttTranscriptionBadgeEl = supportSetting.descEl.createDiv({
            text: this.transcriptionBadgeText(s),
        });
        this.sttTimestampBadgeEl = supportSetting.descEl.createDiv({
            text: this.timestampBadgeText(s),
            cls: "mc-support-detail",
        });
        // Assess transcription + timestamp support for the current model (fires
        // once per endpoint+model per session; no-op when the endpoint isn't
        // set or a fresh verdict is already stored). The "Recheck" button above
        // force-reruns it (and reports the outcome) when a probe came back
        // inconclusive.
        this.maybeAssessSttModel();

        // Engine family = request routing/chunking. It's auto-set from the model
        // above (see the picker's onChange), so this is an advanced override,
        // only needed when a gateway's opaque model name hides which engine it
        // really is. Word timestamps are handled automatically by the probe, so
        // there's no separate "Whisper (word timestamps)" choice: the Whisper
        // engine asks for timestamps and silently falls back when unsupported.
        new Setting(containerEl)
            .setName(s.settings.sttApiType.name)
            .setDesc(s.settings.sttApiType.desc)
            .addDropdown((dd) => {
                this.sttEngineDropdown = dd;
                dd.addOption("gpt-4o-transcribe", s.settings.sttApiType.gpt4o);
                dd.addOption(
                    "gpt-4o-mini-transcribe",
                    s.settings.sttApiType.gpt4oMini
                );
                dd.addOption("whisper-1-ts", s.settings.sttApiType.whisper);
                dd.setValue(this.engineDropdownValue()).onChange(
                    async (value) => {
                        this.plugin.settings.sttApiType = STT_MODELS.includes(
                            value as SttApiType
                        )
                            ? (value as SttApiType)
                            : "gpt-4o-transcribe";
                        await this.plugin.saveSettings();
                        // Update badges in place (no full re-render / scroll
                        // jump) and re-assess against the new engine family.
                        this.refreshSttBadges();
                        this.maybeAssessSttModel();
                    }
                );
            });
    }

    /**
     * Remote-only dictionary rows (custom + GPT-assisted correction), which the
     * vendored engine's pipeline applies. Hidden under the local engine, which
     * doesn't run them.
     */
    private renderRemoteDictionary(containerEl: HTMLElement): void {
        const s = t();
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
                ta.inputEl.rows = TEXTAREA_ROWS;
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
    }

    /**
     * The local (on-device Whisper) transcription rows: model picker, a
     * download/status row that streams the ggml file into the plugin's models
     * dir (verified by SHA-256), and the remote-fallback toggle. Runs entirely
     * on this Mac — no audio leaves the device (issue #34).
     */
    private renderLocalTranscription(containerEl: HTMLElement): void {
        const s = t();
        const spec = localModelSpec(this.plugin.settings.localWhisperModel);

        new Setting(containerEl)
            .setName(s.settings.localModel.name)
            .setDesc(s.settings.localModel.desc)
            .addDropdown((dd) => {
                dd.selectEl.addClass("meeting-copilot-model-dropdown");
                for (const m of Object.values(LOCAL_MODELS)) {
                    dd.addOption(
                        m.id,
                        `${s.settings.localModel.option(m.id)} (${formatBytes(m.sizeBytes)})`
                    );
                }
                dd
                    .setValue(spec.id)
                    // Locked mid-download so the in-flight fetch keeps matching
                    // the model the row is showing.
                    .setDisabled(this.downloadingModel)
                    .onChange(async (value) => {
                        this.plugin.settings.localWhisperModel = value;
                        await this.plugin.saveSettings();
                        // Re-render so the download row reflects the new model's
                        // presence/size.
                        this.display();
                    });
            });

        // Download / status row. The row is held on the instance so an in-flight
        // download's progress ticks (and the final repaint) always target the
        // *current* row — a re-render (engine/model change, tab reopen) rebuilds
        // it here and progress keeps flowing rather than freezing on a detached
        // node.
        this.modelDownloadRow = new Setting(containerEl).setName(
            s.settings.localModelDownload.name
        );
        void this.repaintModelDownloadRow();

        new Setting(containerEl)
            .setName(s.settings.localFallback.name)
            .setDesc(s.settings.localFallback.desc)
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.localFallbackToRemote)
                    .onChange(async (value) => {
                        this.plugin.settings.localFallbackToRemote = value;
                        await this.plugin.saveSettings();
                    })
            );
    }

    /**
     * Repaints the local model download/status row from current state: the live
     * download percentage while a download runs, else a downloaded/missing line
     * with a Delete/Download action. Targets {@link modelDownloadRow}, which
     * {@link renderLocalTranscription} keeps pointed at the on-screen row.
     */
    private async repaintModelDownloadRow(): Promise<void> {
        const row = this.modelDownloadRow;
        if (!row) return;
        const s = t();
        const spec = localModelSpec(this.plugin.settings.localWhisperModel);
        row.controlEl.empty();
        if (this.downloadingModel) {
            row.setDesc(s.settings.localModelDownload.downloading(this.downloadProgress));
            return;
        }
        const present = await this.plugin.localModelPresent(spec);
        row.setDesc(
            present
                ? s.settings.localModelDownload.present(formatBytes(spec.sizeBytes))
                : s.settings.localModelDownload.missing(formatBytes(spec.sizeBytes))
        );
        if (present) {
            row.addButton((b) =>
                b
                    .setButtonText(s.settings.localModelDownload.delete)
                    .setWarning()
                    .onClick(async () => {
                        await this.plugin.deleteLocalModel(spec);
                        await this.repaintModelDownloadRow();
                    })
            );
        } else {
            row.addButton((b) =>
                b
                    .setButtonText(s.settings.localModelDownload.download)
                    .setCta()
                    .onClick(() => void this.startModelDownload(spec))
            );
        }
    }

    /**
     * Streams the selected local model to disk, updating the download row's
     * percentage in place (throttled to whole-percent steps) and repainting to
     * the final state when done. Guards against re-entry while a download runs;
     * the engine + model dropdowns are disabled meanwhile so `spec` stays valid.
     */
    private async startModelDownload(
        spec: ReturnType<typeof localModelSpec>
    ): Promise<void> {
        if (this.downloadingModel) return;
        this.downloadingModel = true;
        this.downloadProgress = 0;
        // Re-render so the engine/model dropdowns lock and the row shows 0%.
        this.display();
        try {
            await this.plugin.ensureLocalModel(spec, (received, total) => {
                const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
                if (pct !== this.downloadProgress) {
                    this.downloadProgress = pct;
                    this.modelDownloadRow?.setDesc(
                        t().settings.localModelDownload.downloading(pct)
                    );
                }
            });
            new Notice(t().settings.localModelDownload.done);
        } catch (e) {
            new Notice(
                t().settings.localModelDownload.failed(
                    e instanceof Error ? e.message : String(e)
                )
            );
        } finally {
            this.downloadingModel = false;
            // Re-render to unlock the dropdowns and repaint the final state.
            this.display();
        }
    }

    /** Speaker-separation + language rows, shared by both engines. */
    private renderDiarizationLanguage(containerEl: HTMLElement): void {
        const s = t();
        const diarizationDesc =
            this.plugin.settings.transcriptionBackend === "local"
                ? s.settings.diarization.descLocal
                : s.settings.diarization.desc;
        new Setting(containerEl)
            .setName(s.settings.diarization.name)
            .setDesc(diarizationDesc)
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.diarizationEnabled)
                    .onChange(async (value) => {
                        this.plugin.settings.diarizationEnabled = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName(s.settings.sttLanguage.name)
            .setDesc(s.settings.sttLanguage.desc)
            .addText((text) =>
                text
                    .setPlaceholder(s.settings.sttLanguage.placeholder)
                    .setValue(this.plugin.settings.sttLanguage)
                    .onChange(async (value) => {
                        this.plugin.settings.sttLanguage =
                            value.trim() || "auto";
                        await this.plugin.saveSettings();
                    })
            );
    }

    /** Automation + logging rows, shared by both engines. */
    private renderTranscriptionAutomation(containerEl: HTMLElement): void {
        const s = t();
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

        new Setting(containerEl)
            .setName(s.settings.debugLogging.name)
            .setDesc(s.settings.debugLogging.desc)
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.debugLogging)
                    .onChange(async (value) => {
                        this.plugin.settings.debugLogging = value;
                        await this.plugin.saveSettings();
                    })
            );
    }

    /** Recording & notes settings, rendered right after meeting detection. */
    private renderRecordingSettings(containerEl: HTMLElement): void {
        const s = t();
		new Setting(containerEl)
			.setName(s.settings.recordingHeading)
			.setHeading();

		new Setting(containerEl)
			.setName(s.settings.compressedRecordings.name)
			.setDesc(s.settings.compressedRecordings.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.compressedRecordings)
					.onChange(async (value) => {
						this.plugin.settings.compressedRecordings = value;
						await this.plugin.saveSettings();
					})
			);

		this.addMicrophoneSetting(containerEl);

		this.addFolderField(
			new Setting(containerEl)
				.setName(s.settings.oneOffFolderTemplate.name)
				.setDesc(s.settings.oneOffFolderTemplate.desc),
			this.plugin.settings.oneOffFolderTemplate,
			DEFAULT_SETTINGS.oneOffFolderTemplate,
			async (value) => {
				this.plugin.settings.oneOffFolderTemplate = value;
				await this.plugin.saveSettings();
			}
		);

		this.addFolderField(
			new Setting(containerEl)
				.setName(s.settings.seriesFolderTemplate.name)
				.setDesc(s.settings.seriesFolderTemplate.desc),
			this.plugin.settings.seriesFolderTemplate,
			DEFAULT_SETTINGS.seriesFolderTemplate,
			async (value) => {
				this.plugin.settings.seriesFolderTemplate = value;
				await this.plugin.saveSettings();
			}
		);

		this.addFolderField(
			new Setting(containerEl)
				.setName(s.settings.adhocFolder.name)
				.setDesc(s.settings.adhocFolder.desc),
			this.plugin.settings.adhocFolder,
			DEFAULT_SETTINGS.adhocFolder,
			async (value) => {
				this.plugin.settings.adhocFolder = value;
				await this.plugin.saveSettings();
			}
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

		this.addFolderField(
			new Setting(containerEl)
				.setName(s.settings.oneOnOneFolder.name)
				.setDesc(s.settings.oneOnOneFolder.desc),
			this.plugin.settings.oneOnOneFolder,
			DEFAULT_SETTINGS.oneOnOneFolder,
			async (value) => {
				this.plugin.settings.oneOnOneFolder = value;
				await this.plugin.saveSettings();
			}
		);

		new Setting(containerEl)
			.setName(s.settings.recordingSubfolder.name)
			.setDesc(s.settings.recordingSubfolder.desc)
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.recordingSubfolder)
					.setValue(this.plugin.settings.recordingSubfolder)
					.onChange(async (value) => {
						this.plugin.settings.recordingSubfolder = value;
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
				ta.inputEl.rows = TEXTAREA_ROWS;
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
     * Badge text for whether the selected model can transcribe. "checking…"
     * while the assessment is in flight, then supported/not supported once a
     * verdict is stored against the current endpoint + model (a since-changed
     * URL or model invalidates it, falling back to the not-checked text).
     */
    private transcriptionBadgeText(s: Messages): string {
        const { apiBaseUrl, sttModel, sttTranscriptionSupported, sttTimestampsProbeKey } =
            this.plugin.settings;
        const currentKey = probeKey(apiBaseUrl, sttModel);
        if (this.probingKey === currentKey) {
            return s.settings.transcriptionBadge.checking;
        }
        if (sttTranscriptionSupported === null || sttTimestampsProbeKey !== currentKey) {
            return s.settings.transcriptionBadge.unknown;
        }
        return sttTranscriptionSupported
            ? s.settings.transcriptionBadge.supported
            : s.settings.transcriptionBadge.notSupported;
    }

    /**
     * Badge text for the model's segment-timestamp support. Only the Whisper
     * timestamp family asks the backend for segments at all, so any other
     * family reads as "not applicable". Within that family: "checking…" while
     * the assessment is in flight, then detected/not detected once a verdict is
     * stored against the current endpoint + model.
     */
    private timestampBadgeText(s: Messages): string {
        const {
            apiBaseUrl,
            sttModel,
            sttApiType,
            sttTimestampsSupported,
            sttTimestampsProbeKey,
        } = this.plugin.settings;
        if (!isTimestampCapableFamily(sttApiType)) {
            return s.settings.timestampBadge.notApplicable;
        }
        const currentKey = probeKey(apiBaseUrl, sttModel);
        if (this.probingKey === currentKey) {
            return s.settings.timestampBadge.checking;
        }
        if (sttTimestampsSupported === null || sttTimestampsProbeKey !== currentKey) {
            return s.settings.timestampBadge.unknown;
        }
        return sttTimestampsSupported
            ? s.settings.timestampBadge.detected
            : s.settings.timestampBadge.notDetected;
    }

    /** The value the engine dropdown should show: the retired no-timestamps "whisper-1" maps onto the single Whisper option. */
    private engineDropdownValue(): SttApiType {
        return this.plugin.settings.sttApiType === "whisper-1"
            ? "whisper-1-ts"
            : this.plugin.settings.sttApiType;
    }

    /** Updates the two STT support badges in place (no full re-render, so scroll position is kept). No-op before the badges have been rendered. */
    private refreshSttBadges(): void {
        const s = t();
        this.sttTranscriptionBadgeEl?.setText(this.transcriptionBadgeText(s));
        this.sttTimestampBadgeEl?.setText(this.timestampBadgeText(s));
    }

    /** Force-reruns the assessment for the current model (used by the "Recheck" button), clearing the once-per-session guard and reporting the outcome. */
    private recheckSttSupport(): void {
        const { apiBaseUrl, sttModel } = this.plugin.settings;
        if (!apiBaseUrl || !sttModel) {
            new Notice(t().settings.testConnection.noBaseUrl);
            return;
        }
        this.probedKeys.delete(probeKey(apiBaseUrl, sttModel));
        this.maybeAssessSttModel(true);
    }

    /**
     * Fire-and-forget assessment of the current transcription model, triggered
     * on render (so it runs on open and after a model change) and by the
     * "Recheck" button. Transcription support comes from the endpoint's
     * declared capabilities when available (LiteLLM), otherwise from a probe of
     * `/audio/transcriptions`; timestamp support is probed only for the Whisper
     * family (the only one that asks for segments). It runs at most once per
     * endpoint+model key per session (unless {@link recheckSttSupport} clears
     * the guard) so re-renders — and an "unknown" result that leaves stored
     * verdicts untouched — can't spin it into a loop. Verdicts are persisted and
     * the badges refreshed in place. When `notify` is set (manual recheck), the
     * outcome — including *why* an inconclusive probe failed — is surfaced as a
     * Notice.
     */
    private maybeAssessSttModel(notify = false): void {
        const { apiBaseUrl, apiKey, sttModel, sttApiType } =
            this.plugin.settings;
        if (!apiBaseUrl || !sttModel) return;
        const key = probeKey(apiBaseUrl, sttModel);
        const wantsTimestamps = isTimestampCapableFamily(sttApiType);
        // A fresh, complete verdict is already stored for this exact pair.
        const haveTranscription =
            this.plugin.settings.sttTimestampsProbeKey === key &&
            this.plugin.settings.sttTranscriptionSupported !== null;
        const haveTimestamps =
            !wantsTimestamps ||
            (this.plugin.settings.sttTimestampsProbeKey === key &&
                this.plugin.settings.sttTimestampsSupported !== null);
        if (haveTranscription && haveTimestamps && !notify) return;
        if (this.probedKeys.has(key) && !notify) return;
        this.probedKeys.add(key);
        this.probingKey = key;
        this.refreshSttBadges();
        void (async () => {
            let detail = "";
            try {
                const declared = this.capabilities?.get(sttModel)?.transcription;
                let transcription: boolean | null = declared ?? null;
                let timestamps: boolean | null = null;
                // Skip the probe entirely if capabilities say this model can't
                // transcribe; otherwise probe (for the transcription verdict
                // when the endpoint didn't declare one, and/or for timestamps).
                if (declared === false) {
                    timestamps = false;
                } else if (declared === undefined || wantsTimestamps) {
                    const support = await probeSttSupport({
                        baseUrl: apiBaseUrl,
                        apiKey,
                        wireModel: sttModel,
                        withTimestamps: wantsTimestamps,
                    });
                    detail = support.detail;
                    let transcriptionVerdict = support.transcription;
                    let timestampVerdict = support.timestamps;
                    // A verbose_json request that was *definitively rejected*
                    // (a 4xx model-rejected status) is ambiguous: the model may
                    // transcribe fine but reject the timestamp params. Re-probe
                    // with plain json so we don't mislabel a good Whisper model
                    // as "can't transcribe" just because it won't emit segments.
                    // Only on a hard `unsupported` — an `unknown` verbose result
                    // (5xx/429/network) is transient, and reprobing then would
                    // wrongly persist "timestamps unsupported" off a flaky call.
                    if (
                        wantsTimestamps &&
                        transcriptionVerdict === "unsupported"
                    ) {
                        const plain = await probeSttSupport({
                            baseUrl: apiBaseUrl,
                            apiKey,
                            wireModel: sttModel,
                            withTimestamps: false,
                        });
                        detail = plain.detail;
                        transcriptionVerdict = plain.transcription;
                        // If plain transcription works, the earlier rejection
                        // was the timestamps; otherwise it's genuinely not a
                        // transcription model (leave timestamps inconclusive).
                        timestampVerdict =
                            plain.transcription === "supported"
                                ? "unsupported"
                                : "unknown";
                    }
                    if (declared === undefined) {
                        transcription =
                            transcriptionVerdict === "supported"
                                ? true
                                : transcriptionVerdict === "unsupported"
                                    ? false
                                    : null;
                    }
                    if (wantsTimestamps && timestampVerdict !== "unknown") {
                        timestamps = timestampVerdict === "supported";
                    }
                }
                let changed = false;
                if (transcription !== null) {
                    this.plugin.settings.sttTranscriptionSupported =
                        transcription;
                    changed = true;
                }
                if (timestamps !== null) {
                    this.plugin.settings.sttTimestampsSupported = timestamps;
                    changed = true;
                }
                if (changed) {
                    this.plugin.settings.sttTimestampsProbeKey = key;
                    await this.plugin.saveSettings();
                }
                if (notify) {
                    new Notice(
                        this.assessmentNotice(
                            transcription,
                            timestamps,
                            wantsTimestamps,
                            detail
                        )
                    );
                }
            } finally {
                if (this.probingKey === key) this.probingKey = null;
                this.refreshSttBadges();
            }
        })();
    }

    /**
     * Builds the Notice text for a manual recheck from *this run's* verdicts
     * (not the stored flags, which can still hold a previous model's result when
     * the current probe was inconclusive). An inconclusive transcription verdict
     * is reported with its HTTP status / error so the user can see why.
     */
    private assessmentNotice(
        transcription: boolean | null,
        timestamps: boolean | null,
        wantsTimestamps: boolean,
        detail: string
    ): string {
        const s = t().settings.recheckSupport;
        if (transcription === false) return s.notTranscription;
        if (transcription === null) return s.inconclusive(detail);
        if (!wantsTimestamps) return s.transcribes;
        if (timestamps === true) return s.timestampsYes;
        if (timestamps === false) return s.timestampsNo;
        // Transcription works but the timestamp verdict was inconclusive.
        return s.transcribes;
    }

    /**
     * Microphone (input device) picker with a refresh button. The device list
     * is enumerated from the recorder helper's `list-devices`; "System default"
     * is always offered, and a saved-but-currently-absent device stays visible
     * (labelled unavailable) so it doesn't silently reset. Repaints its own row
     * in place so refreshing doesn't scroll-jump the tab.
     */
    private addMicrophoneSetting(containerEl: HTMLElement): void {
        const s = t();
        const setting = new Setting(containerEl)
            .setName(s.settings.microphone.name)
            .setDesc(s.settings.microphone.desc);

        const paint = (): void => {
            setting.controlEl.empty();
            const current = this.plugin.settings.micDeviceUid;
            const options: Record<string, string> = {
                "": s.settings.microphone.systemDefault,
            };
            for (const d of this.inputDevices) options[d.uid] = d.name;
            // Keep a stored device that isn't in the current list visible and
            // selectable (marked unavailable) rather than snapping to default.
            if (current && !options[current]) {
                options[current] = s.settings.microphone.unavailableOption(
                    this.plugin.settings.micDeviceLabel || current
                );
            }
            setting.addDropdown((dd) => {
                dd.selectEl.addClass("meeting-copilot-model-dropdown");
                dd.addOptions(options)
                    .setValue(current)
                    .onChange(async (value) => {
                        this.plugin.settings.micDeviceUid = value;
                        const match = this.inputDevices.find(
                            (d) => d.uid === value
                        );
                        if (match) {
                            this.plugin.settings.micDeviceLabel = match.name;
                        } else if (!value) {
                            // Back to system default: no label to remember.
                            this.plugin.settings.micDeviceLabel = "";
                        }
                        // Else: re-selecting a saved-but-absent device — keep
                        // the remembered label so the record-time "unavailable"
                        // notice can still name it (a blank would show the UID).
                        await this.plugin.saveSettings();
                    });
            });
            setting.addExtraButton((btn) =>
                btn
                    .setIcon("refresh-cw")
                    .setTooltip(s.settings.microphone.refresh)
                    .setDisabled(this.listingDevices)
                    .onClick(() => void this.refreshInputDevices(paint))
            );
        };

        paint();
        // Best-effort populate on open, but never trigger a helper download for
        // it — the refresh button force-ensures the binary when the user asks.
        if (this.inputDevices.length === 0 && !this.listingDevices) {
            void this.refreshInputDevices(paint, { allowDownload: false });
        }
    }

    /**
     * Enumerate input devices from the helper and repaint the picker. `repaint`
     * is called at start (to disable the button / show it's working) and on
     * completion. A best-effort load ({ allowDownload: false }) that comes back
     * empty because the binary isn't present yet leaves any existing list
     * intact; an explicit refresh replaces it.
     */
    private async refreshInputDevices(
        repaint: () => void,
        opts?: { allowDownload?: boolean }
    ): Promise<void> {
        if (this.listingDevices) return;
        this.listingDevices = true;
        repaint();
        try {
            const devices = await this.plugin.listInputDevices(opts);
            const explicit = opts?.allowDownload !== false;
            if (devices.length > 0 || explicit) {
                this.inputDevices = devices;
            }
            // Refresh the remembered label for the current selection if we can
            // see it now (a device rename, or first successful enumeration).
            const current = this.plugin.settings.micDeviceUid;
            const match = this.inputDevices.find((d) => d.uid === current);
            if (match && match.name !== this.plugin.settings.micDeviceLabel) {
                this.plugin.settings.micDeviceLabel = match.name;
                await this.plugin.saveSettings();
            }
        } finally {
            this.listingDevices = false;
            repaint();
        }
    }

    /**
     * Text field for one of the folder/template settings (one-off, series,
     * ad-hoc, 1:1), which all share the same shape: a placeholder of the
     * default value, and an empty/blank edit reverting to that default rather
     * than being saved as "".
     */
    private addFolderField(
        setting: Setting,
        current: string,
        defaultValue: string,
        onChange: (value: string) => Promise<void>
    ): void {
        setting.addText((text) =>
            text
                .setPlaceholder(defaultValue)
                .setValue(current)
                .onChange(async (value) => {
                    await onChange(value.trim() || defaultValue);
                })
        );
    }

    /**
     * Model picker used by both transcription and enrichment. Shows a dropdown
     * of the models fetched from the endpoint (via "Load models"), keeping
     * the current value selectable even if the endpoint didn't list it. Falls
     * back to a free-text field when no models have been loaded yet so the user
     * can still type a model id offline. An optional `filter` narrows the
     * offered options (e.g. transcription-only for the STT picker); the current
     * value is always kept selectable even if it wouldn't pass the filter.
     */
    private addModelPicker(
        setting: Setting,
        current: string,
        onChange: (value: string) => Promise<void>,
        filter?: (modelId: string) => boolean
    ): void {
        const offered = filter ? this.models.filter(filter) : this.models;
        if (offered.length > 0 || (current && this.models.length > 0)) {
            const options: Record<string, string> = {};
            for (const m of offered) options[m] = m;
            if (current && !options[current]) options[current] = current;
            setting.addDropdown((dd) => {
                dd.selectEl.addClass("meeting-copilot-model-dropdown");
                dd
                    .addOptions(options)
                    .setValue(current)
                    .onChange(async (value) => {
                        await onChange(value);
                    });
            });
        } else {
            setting.addText((text) =>
                text.setValue(current).onChange(async (value) => {
                    await onChange(value.trim());
                })
            );
        }
    }
}
