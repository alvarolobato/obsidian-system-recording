import { App, TFile } from "obsidian";
import { TranscriptionController } from "./vendor/application/TranscriptionController";
import {
	DEFAULT_API_SETTINGS,
	type APITranscriptionSettings,
	type LanguageDictionaries,
	type TranscriptionModel,
	type VADMode,
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
import { mergeDiarized, type DiarSegment, type SpeechWindows } from "./diarize";
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
	/** Only "server" | "disabled" are wired; local VAD needs a WASM asset we don't ship. */
	vadMode: VADMode;
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

/** What the vendored controller hands back once its return was widened. */
type ControllerResult =
	| string
	| { text: string; modelUsed: string; segments?: DiarSegment[] };

/**
 * One pass through the vendored controller. Sets the process-global endpoint
 * seam and builds the vendored settings from our config. This does NOT enter
 * the serial queue itself; callers own the queueing (see the note above).
 */
async function runController(
	app: App,
	file: TFile,
	cfg: TranscribeConfig,
	signal?: AbortSignal
): Promise<ControllerResult> {
	setTranscribeBaseUrl(cfg.baseUrl);
	setTranscribeModelOverride(cfg.modelOverride);
	setChatModelOverride(cfg.chatModel);
	const settings: APITranscriptionSettings = {
		...DEFAULT_API_SETTINGS,
		openaiApiKey: cfg.apiKey ? `PLAIN::${cfg.apiKey}` : "",
		model: cfg.model,
		language: cfg.language,
		vadMode: cfg.vadMode,
		postProcessingEnabled: cfg.postProcessingEnabled,
		dictionaryCorrectionEnabled: cfg.dictionaryCorrectionEnabled,
		userDictionaries: cfg.userDictionaries,
		debugMode: cfg.debugMode,
	};
	const controller = new TranscriptionController(app, settings);
	return controller.transcribe(file, undefined, undefined, signal);
}

async function runTranscription(
	app: App,
	file: TFile,
	cfg: TranscribeConfig,
	signal?: AbortSignal
): Promise<string> {
	const result = await runController(app, file, cfg, signal);
	return typeof result === "string" ? result : result.text;
}

function extractSegments(result: ControllerResult): DiarSegment[] {
	if (typeof result === "string" || !result.segments) {
		return [];
	}
	return result.segments;
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

export interface DiarizedResult {
	text: string;
	diarized: boolean;
}

/**
 * Transcribes the two mono sidecar streams (mic = "me", system audio = "them")
 * and merges them into one speaker-labelled transcript on their shared clock.
 *
 * Both passes run inside the same serial queue as {@link transcribeAudio} so
 * the process-global endpoint seam can't be overwritten mid-flight.
 *
 * Dictionary correction is only applied to the joined text in the normal
 * (mixed-file) path. The vendored controller corrects `result.text` but leaves
 * the timestamped segments untouched, and the diarized output is built from
 * those segments, so no dictionary correction reaches it. Known v1 limitation.
 *
 * If either pass returns no segments (the endpoint didn't honor the timestamp
 * request), this resolves with `diarized: false` so the caller can fall back to
 * transcribing the mixed-down file.
 */
export function transcribeDiarized(
	app: App,
	meFile: TFile,
	themFile: TFile,
	cfg: TranscribeConfig,
	windows?: SpeechWindows,
	signal?: AbortSignal
): Promise<DiarizedResult> {
	return serial(async () => {
		// Force VAD off for both passes. Server- or local-side VAD trims silence,
		// and it would trim each stream by a different amount (the mic is mostly
		// silence, the room audio isn't), shifting their timestamps out of sync
		// and shearing the shared timeline the merge relies on. We want the raw,
		// aligned clocks.
		const diarCfg: TranscribeConfig = { ...cfg, vadMode: "disabled" };

		const meResult = await runController(app, meFile, diarCfg, signal);
		if (signal?.aborted) {
			throw new DOMException("Transcription aborted", "AbortError");
		}
		const themResult = await runController(app, themFile, diarCfg, signal);

		const meSegments = extractSegments(meResult);
		const themSegments = extractSegments(themResult);

		if (meSegments.length === 0 || themSegments.length === 0) {
			return { text: "", diarized: false };
		}

		return { text: mergeDiarized(meSegments, themSegments, windows), diarized: true };
	});
}
