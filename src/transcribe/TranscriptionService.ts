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
	t,
} from "./vendor/i18n/index";
import { PathUtils } from "./vendor/utils/PathUtils";
import { Logger, LogLevel } from "./vendor/utils/Logger";
import { ProgressTracker } from "./vendor/ui/ProgressTracker";
import { createSerialQueue } from "../util/serialize";
import { mergeDiarized, type DiarSegment, type SpeechWindows } from "./diarize";
import { stripHallucinatedLines } from "./hallucination";
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

/** What the vendored controller hands back once its return was widened. */
type ControllerResult =
	| string
	| { text: string; modelUsed: string; segments?: DiarSegment[] };

/**
 * One pass through the vendored controller. Sets the process-global endpoint
 * seam and builds the vendored settings from our config. This does NOT enter
 * the serial queue itself; callers own the queueing (see the note above).
 *
 * vadMode is not part of TranscribeConfig (the setting was retired; normal
 * transcription always uses server VAD), but the diarized passes must run
 * with VAD off, so it's a parameter here rather than a config field.
 */
async function runController(
	app: App,
	file: TFile,
	cfg: TranscribeConfig,
	signal?: AbortSignal,
	vadMode: APITranscriptionSettings["vadMode"] = "server",
	onProgress?: (percent: number) => void,
	label = "single"
): Promise<ControllerResult> {
	setTranscribeBaseUrl(cfg.baseUrl);
	setTranscribeModelOverride(cfg.modelOverride);
	setChatModelOverride(cfg.chatModel);
	// Surface the vendored engine's own per-chunk / per-batch timing (it logs
	// each chunk's elapsedTime at DEBUG) when debug mode is on. The singleton
	// otherwise sits at INFO, which hides those lines. The coarse pass timing
	// below is always on and cheap (a couple of lines per pass).
	Logger.getInstance({
		debugMode: cfg.debugMode,
		logLevel: cfg.debugMode ? LogLevel.DEBUG : LogLevel.INFO,
	});
	const settings: APITranscriptionSettings = {
		...DEFAULT_API_SETTINGS,
		openaiApiKey: cfg.apiKey ? `PLAIN::${cfg.apiKey}` : "",
		model: cfg.model,
		language: cfg.language,
		vadMode,
		postProcessingEnabled: cfg.postProcessingEnabled,
		dictionaryCorrectionEnabled: cfg.dictionaryCorrectionEnabled,
		userDictionaries: cfg.userDictionaries,
		debugMode: cfg.debugMode,
	};
	// The vendored engine only emits progress when a tracker is supplied and its
	// getCurrentTask() is non-null; our headless tracker keeps a live task and
	// forwards the engine's unified percentage to the caller.
	const tracker = onProgress ? new ProgressTracker(onProgress) : undefined;
	const controller = new TranscriptionController(app, settings, tracker);
	const t0 = perfNow();
	const modelLabel = cfg.modelOverride
		? `${cfg.model}→${cfg.modelOverride}`
		: cfg.model;
	// console.warn (not .info/.debug) so the line is visible in Obsidian's
	// console without switching on Verbose — matches the vendored Logger.
	console.warn(
		`[Meeting Copilot][transcribe] ${label} pass start (model=${modelLabel}, vad=${vadMode}, postproc=${cfg.postProcessingEnabled}, dict=${cfg.dictionaryCorrectionEnabled})`
	);
	try {
		const result = await controller.transcribe(file, undefined, undefined, signal);
		console.warn(
			`[Meeting Copilot][transcribe] ${label} pass done in ${elapsedSecs(t0)}s`
		);
		return result;
	} catch (e) {
		console.warn(
			`[Meeting Copilot][transcribe] ${label} pass failed after ${elapsedSecs(t0)}s`
		);
		throw e;
	}
}

/** High-resolution clock when available, wall-clock otherwise. */
function perfNow(): number {
	return typeof performance !== "undefined" && typeof performance.now === "function"
		? performance.now()
		: Date.now();
}

/** Seconds since `t0` (from {@link perfNow}), to one decimal. */
function elapsedSecs(t0: number): string {
	return ((perfNow() - t0) / 1000).toFixed(1);
}

/**
 * The vendored engine's unified percentage runs ~10% (preparation) → 90%
 * (transcription), never 100 (it stops before the caller-owned insert step),
 * so rescale that 10→90 band onto a full 0–100 bar — a single pass fills it
 * end to end and the diarized halves line up on 0–50 / 50–100. When the
 * optional post-processing step is enabled the engine caps transcription at
 * ~70% and doesn't report the post-processing phase, so the bar tops out near
 * ~75% until the pass returns; that mode is off by default.
 */
export function normalizeEngineProgress(percent: number): number {
	const scaled = ((percent - 10) / 80) * 100;
	return Math.max(0, Math.min(100, scaled));
}

async function runTranscription(
	app: App,
	file: TFile,
	cfg: TranscribeConfig,
	signal?: AbortSignal,
	onProgress?: (percent: number) => void
): Promise<string> {
	const scaled = onProgress
		? (p: number) => onProgress(normalizeEngineProgress(p))
		: undefined;
	const result = await runController(app, file, cfg, signal, "server", scaled, "mixed");
	return typeof result === "string" ? result : result.text;
}

function extractSegments(result: ControllerResult): DiarSegment[] {
	if (typeof result === "string" || !result.segments) {
		return [];
	}
	return result.segments;
}

function resultText(result: ControllerResult): string {
	return typeof result === "string" ? result : result.text;
}

/**
 * A pass that produced no segments but real (non-hallucination) text is a
 * capability miss: the endpoint transcribed the audio yet ignored the timestamp
 * request, so we have nothing to place on the shared clock and can't diarize.
 *
 * Distinguished from:
 *   - a legitimately silent stream (no segments AND no text), and
 *   - a SILENT stream whose text is nothing but a Whisper hallucination
 *     ("Thanks for watching."): an endpoint that drops the segments array on
 *     silence (some proxies do) must NOT be read as timestamp-incapable, or a
 *     silent meeting would null the probe and disable speaker separation for
 *     every future meeting (the #61 failure mode). Strip stock phrases first;
 *     if nothing real remains, it's silence, not a miss.
 */
export function isCapabilityMiss(segments: DiarSegment[], text: string): boolean {
	return segments.length === 0 && stripHallucinatedLines(text).length > 0;
}

/**
 * Whether an error thrown by a transcription pass is a user cancellation (which
 * must propagate) rather than a recoverable failure. Mirrors the cases the
 * vendored controller itself treats as cancellation.
 */
export function isDiarizationCancelled(error: unknown, signal?: AbortSignal): boolean {
	return (
		(signal?.aborted ?? false) ||
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.message === t("errors.transcriptionCancelledByUser"))
	);
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
	signal?: AbortSignal,
	onProgress?: (percent: number) => void
): Promise<string> {
	return serial(() => runTranscription(app, file, cfg, signal, onProgress));
}

export interface DiarizedResult {
	text: string;
	diarized: boolean;
	/**
	 * Why a non-diarized result came back, so the caller can react correctly:
	 *   - "capability": the endpoint transcribed audio but ignored the timestamp
	 *     request, so no future meeting can diarize either — invalidate the probe.
	 *   - "error": a transient failure this run (flaky chunk, network). The next
	 *     meeting may well succeed, so DON'T touch the cached probe.
	 * Undefined when `diarized` is true.
	 */
	reason?: "capability" | "error";
}

/**
 * Whether a non-diarized fallback should invalidate the cached timestamp probe.
 *
 * Only a genuine capability miss (the endpoint transcribed audio but ignored
 * the timestamp request) means no future meeting can diarize, so the probe
 * should be cleared. A transient error this run (a flaky chunk, a network blip)
 * says nothing about the endpoint's capability, so the probe must stay put —
 * otherwise one bad run silently disables speaker separation for every future
 * meeting until the user manually re-checks (issue #61).
 */
export function shouldInvalidateProbe(result: DiarizedResult): boolean {
	return !result.diarized && result.reason === "capability";
}

/**
 * Transcribes the two mono sidecar streams (mic = "me", system audio = "them")
 * and merges them into one speaker-labelled transcript on their shared clock.
 *
 * Both passes run inside the same serial queue as {@link transcribeAudio} so
 * the process-global endpoint seam can't be overwritten mid-flight.
 *
 * Two vendored post-passes only touch the joined text in the normal
 * (mixed-file) path, never the segments the diarized output is rebuilt from, so
 * neither reaches the diarized transcript. Known v1 limitation:
 *   - dictionary correction (applyDictionaryCorrection on result.text), and
 *   - the hallucination cleaner (postProcessMergedText / cleanText in the
 *     strategy), which likewise runs on merged text only.
 *
 * If a pass is a capability miss (no segments but real, non-hallucination
 * text, i.e. the endpoint ignored the timestamp request) this resolves with
 * `diarized: false` so the caller can fall back to transcribing the mixed-down
 * file. A truly silent stream — no segments and either no text or only stock
 * hallucination text — is not a miss and we proceed (see {@link isCapabilityMiss}).
 */
export function transcribeDiarized(
	app: App,
	meFile: TFile,
	themFile: TFile,
	cfg: TranscribeConfig,
	windows?: SpeechWindows,
	signal?: AbortSignal,
	onProgress?: (percent: number) => void
): Promise<DiarizedResult> {
	// The two passes run back-to-back, so map each onto half of the overall bar:
	// "me" fills 0–50%, "them" 50–100% (each pass rescaled to a full 0–100 first).
	const meProgress = onProgress
		? (p: number) => onProgress(normalizeEngineProgress(p) * 0.5)
		: undefined;
	const themProgress = onProgress
		? (p: number) => onProgress(50 + normalizeEngineProgress(p) * 0.5)
		: undefined;
	return serial(async () => {
		// Force VAD off for both passes. Server- or local-side VAD trims silence,
		// and it would trim each stream by a different amount (the mic is mostly
		// silence, the room audio isn't), shifting their timestamps out of sync
		// and shearing the shared timeline the merge relies on. We want the raw,
		// aligned clocks.
		const tAll = perfNow();
		console.warn(
			"[Meeting Copilot][transcribe] diarized: 2 serial passes (me, them)"
		);
		try {
			const meResult = await runController(app, meFile, cfg, signal, "disabled", meProgress, "me");
			if (signal?.aborted) {
				throw new DOMException("Transcription aborted", "AbortError");
			}

			// Classify the me pass before spending a full them pass. If the
			// endpoint ignored the timestamp request we can't diarize either
			// stream, so bail now: me + fallback is 2 passes instead of the
			// me + them + fallback 3 we'd pay by checking after both passes.
			const meSegments = extractSegments(meResult);
			if (isCapabilityMiss(meSegments, resultText(meResult))) {
				return { text: "", diarized: false, reason: "capability" };
			}

			const themResult = await runController(app, themFile, cfg, signal, "disabled", themProgress, "them");
			const themSegments = extractSegments(themResult);
			if (isCapabilityMiss(themSegments, resultText(themResult))) {
				return { text: "", diarized: false, reason: "capability" };
			}

			// Both passes honored timestamps. A stream empty here is legitimately
			// silent; mergeDiarized handles one empty side, and two give "".
			console.warn(
				`[Meeting Copilot][transcribe] diarized both passes done in ${elapsedSecs(tAll)}s`
			);
			return { text: mergeDiarized(meSegments, themSegments, windows), diarized: true };
		} catch (error) {
			if (isDiarizationCancelled(error, signal)) {
				throw error;
			}
			// A partial mono pass throws the partial-marker text (one flaky chunk).
			// That must not kill the whole transcription: the mixed wav can still
			// be transcribed, so warn and let the caller fall back to it rather
			// than letting the throw escape and leave no transcript written.
			console.warn("Diarized transcription pass failed; falling back to mixed file", error);
			return { text: "", diarized: false, reason: "error" };
		}
	});
}
