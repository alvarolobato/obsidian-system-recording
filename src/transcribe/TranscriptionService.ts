import { App, TFile } from "obsidian";
import { TranscriptionController } from "./vendor/application/TranscriptionController";
import {
	DEFAULT_API_SETTINGS,
	type APITranscriptionSettings,
	type LanguageDictionaries,
	type TranscriptionModel,
} from "./vendor/ApiSettings";
import {
	setChatModelOverride,
	setTranscribeBaseUrl,
	setTranscribeModelOverride,
} from "./endpointConfig";
import {
	initializeI18n,
	initializeTranslations,
} from "./vendor/i18n/index";
import { PathUtils } from "./vendor/utils/PathUtils";
import { createSerialQueue } from "../util/serialize";
import en from "./vendor/i18n/translations/en";
import ja from "./vendor/i18n/translations/ja";
import ko from "./vendor/i18n/translations/ko";
import zh from "./vendor/i18n/translations/zh";


let engineInitialized = false;

/**
 * One-time setup for the vendored transcription engine: loads its i18n bundles
 * (so its error/prompt strings resolve) and records the plugin dir. Safe to
 * call repeatedly.
 */
export function initTranscribeEngine(manifestDir: string | null): void {
	if (!engineInitialized) {
		initializeTranslations({ en, ja, ko, zh });
		initializeI18n();
		engineInitialized = true;
	}
	PathUtils.setPluginDir(manifestDir);
}

/** Everything the vendored controller needs, sourced from our own settings. */
export interface TranscribeConfig {
	baseUrl: string;
	apiKey: string;
	model: TranscriptionModel;
	/** Wire model id override for renaming gateways; "" uses the canonical model. */
	modelOverride: string;
	/** Chat model for GPT-assisted dictionary correction; "" uses the engine default. */
	chatModel: string;
	language: string;
	postProcessingEnabled: boolean;
	dictionaryCorrectionEnabled: boolean;
	userDictionaries: LanguageDictionaries;
	debugMode: boolean;
}

// The endpoint seam (base URL + wire model id) is a process-wide singleton the
// vendored clients read lazily at construction time — after this function's
// awaits. Serialize runs so a second transcription can't overwrite the globals
// mid-flight. Meetings are transcribed one at a time in practice, so a queue is
// cheaper than threading config through the (pristine) vendored constructors.
const serial = createSerialQueue();

async function runTranscription(
	app: App,
	file: TFile,
	cfg: TranscribeConfig,
	signal?: AbortSignal
): Promise<string> {
	setTranscribeBaseUrl(cfg.baseUrl);
	setTranscribeModelOverride(cfg.modelOverride);
	setChatModelOverride(cfg.chatModel);
	const settings: APITranscriptionSettings = {
		...DEFAULT_API_SETTINGS,
		openaiApiKey: cfg.apiKey ? `PLAIN::${cfg.apiKey}` : "",
		model: cfg.model,
		language: cfg.language,
		vadMode: "server",
		postProcessingEnabled: cfg.postProcessingEnabled,
		dictionaryCorrectionEnabled: cfg.dictionaryCorrectionEnabled,
		userDictionaries: cfg.userDictionaries,
		debugMode: cfg.debugMode,
	};
	const controller = new TranscriptionController(app, settings);
	const result = await controller.transcribe(file, undefined, undefined, signal);
	return typeof result === "string" ? result : result.text;
}

/**
 * Runs the vendored transcription engine headlessly and returns the transcript
 * text. The endpoint is injected via {@link setTranscribeBaseUrl}; the key is
 * stored plaintext (prefixed so the vendored SafeStorage passes it through).
 * Runs are serialized (see note above).
 */
export function transcribeAudio(
	app: App,
	file: TFile,
	cfg: TranscribeConfig,
	signal?: AbortSignal
): Promise<string> {
	return serial(() => runTranscription(app, file, cfg, signal));
}
