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
import { Logger, LogLevel } from "./vendor/utils/Logger";
import { ProgressTracker } from "./vendor/ui/ProgressTracker";
import { getModelConfig } from "./vendor/config/ModelProcessingConfig";
import { createSerialQueue } from "../util/serialize";
import { isDiarizationCancelled } from "./cancellation";
import { runJobsSequentially } from "./backend";
import type { DiarSegment } from "./diarize";
import {
	encodeWavFromFloat32,
	estimateFullPassChunkCount,
	plannedCoverageSeconds,
	plannedSpeechSeconds,
	planPregatedChunks,
	rangesToChunkBounds,
} from "./pregate";
import { decodeMono16k } from "./vadWindows";
import type { AudioChunk } from "./vendor/core/audio/AudioTypes";
import type {
	JobResult,
	SpeechWindowSource,
	TranscribeJob,
	TranscribeRequest,
	TranscriptionBackend,
	ValidationResult,
} from "./backend";

/** Everything the OpenAI-compatible backend needs, sourced from our own settings. */
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
//
// MODULE-level (not per-instance): the globals it guards are process-wide, so
// every OpenAICompatibleBackend instance must share the one queue even though
// main.ts builds a fresh backend per transcription.
const serial = createSerialQueue();

/** What the vendored controller hands back once its return was widened. */
type ControllerResult =
	| string
	| { text: string; modelUsed: string; segments?: DiarSegment[] };

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

// Extra padding (seconds) added on each side of a detected window before
// slicing, so a word onset/offset just outside the window isn't clipped from
// the upload. Local VAD windows are already internally padded ~0.3s and come
// from a real speech classifier, so a small pad suffices; the recorder's RMS
// windows are unpadded and threshold-based (quiet speech at ~-40 dBFS sits under
// the gate), so they get a generous pad. See {@link buildPregatedChunks}.
const PREGATE_PADDING_VAD_SECONDS = 0.5;
const PREGATE_PADDING_RMS_SECONDS = 1.5;
// Bridge speech windows separated by <= this much silence into one chunk, so
// nearby turns don't fragment into many tiny requests. A bridged pause uploads a
// few seconds of silence but saves a whole round trip (and its share of the
// inter-batch rate-limit delay), which on a talk-dense stream is the difference
// between pre-gating being a win or a regression. Wider gaps are dropped from
// the upload — the whole point of pre-gating.
const PREGATE_MERGE_GAP_SECONDS = 3.0;
// Fold a split region's sub-min trailing chunk into its predecessor rather than
// sending a tiny request. Does NOT drop short *standalone* speech windows.
const PREGATE_MIN_CHUNK_SECONDS = 5.0;
// Grow a lone short speech region (a backchannel: "mm-hm", "yeah") out to this
// floor by absorbing adjacent silence, so it isn't uploaded as a sub-second,
// context-free clip — Whisper's most hallucination-prone regime. Nothing is
// dropped; only silence is added around the real utterance.
const PREGATE_MIN_STANDALONE_SECONDS = 3.0;

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
 * The transcription backend that targets any OpenAI-compatible
 * `/audio/transcriptions` endpoint via the vendored engine.
 *
 * This class is the *only* place the vendored engine, the `PLAIN::` key
 * contract, the process-global endpoint seam, and the serial queue live — the
 * orchestrator ({@link ./TranscriptionService}) and its callers code strictly
 * against {@link TranscriptionBackend}.
 */
export class OpenAICompatibleBackend implements TranscriptionBackend {
	readonly id = "openai-compatible" as const;

	constructor(
		private readonly app: App,
		private readonly config: TranscribeConfig
	) {}

	async validateConfig(): Promise<ValidationResult> {
		const c = this.config;
		if (!c.baseUrl.trim()) {
			return { ok: false, message: "No API base URL configured." };
		}
		if (!c.apiKey.trim()) {
			return { ok: false, message: "No API key configured." };
		}
		if (!c.model) {
			return { ok: false, message: "No transcription model configured." };
		}
		return { ok: true };
	}

	transcribe(req: TranscribeRequest): Promise<JobResult[]> {
		// One serial slot for the whole request: both diarized passes (me, them)
		// run back-to-back under a single slot so the process-global endpoint
		// seam can't be overwritten mid-flight by another transcription.
		return serial(() => this.runJobs(req));
	}

	private async runJobs(req: TranscribeRequest): Promise<JobResult[]> {
		const n = req.jobs.length;
		const tAll = perfNow();
		if (n > 1) {
			console.warn(
				`[Meeting Copilot][transcribe] ${n} serial passes (${req.jobs.map((j) => j.id).join(", ")})`
			);
		}
		// The sequential loop, bar-slicing, abort ordering, and early-bail hook
		// are the shared backend contract. runJob receives a job-LOCAL 0–100
		// progress; it maps the engine's 10→90 band onto that local bar.
		const results = await runJobsSequentially(req, (job, ctx) =>
			this.runJob(job, ctx.signal, ctx.onProgress)
		);
		if (n > 1) {
			console.warn(
				`[Meeting Copilot][transcribe] ${results.length} pass(es) done in ${elapsedSecs(tAll)}s`
			);
		}
		return results;
	}

	private async runJob(
		job: TranscribeJob,
		signal: AbortSignal | undefined,
		onJobProgress: ((jobPercent: number) => void) | undefined
	): Promise<JobResult> {
		// The vendored engine emits its unified 10→90 percentage; rescale it onto
		// this job's local 0–100 bar. The shared runner then slices that into the
		// job's lane of the whole-request bar.
		const onProgress = onJobProgress
			? (enginePct: number) => onJobProgress(normalizeEngineProgress(enginePct))
			: undefined;
		// Diarized passes must run with VAD off: server/local silence-trimming
		// would trim each stream by a different amount and shear the shared
		// timeline the merge relies on. The mixed pass wants server VAD.
		const vadMode: APITranscriptionSettings["vadMode"] = job.wantSegments
			? "disabled"
			: "server";
		// Pre-gate the upload to the job's speech windows (issue #67) when it has
		// any; else transcribe the whole file. buildPregatedChunks returns null
		// ("run a full pass") when the plan wouldn't beat a full pass or decoding
		// fails, so speech is never silently dropped.
		const chunks =
			job.speechWindows && job.windowSource
				? await this.buildPregatedChunks(
						job.file,
						job.speechWindows,
						job.windowSource,
						signal
					)
				: null;
		const result = await this.runController(
			job.file,
			signal,
			vadMode,
			onProgress,
			job.id,
			chunks ?? undefined
		);
		return {
			id: job.id,
			text: resultText(result),
			segments: job.wantSegments ? extractSegments(result) : undefined,
		};
	}

	/**
	 * One pass through the vendored controller. Sets the process-global endpoint
	 * seam and builds the vendored settings from our config.
	 */
	private async runController(
		file: TFile,
		signal: AbortSignal | undefined,
		vadMode: APITranscriptionSettings["vadMode"],
		onProgress: ((percent: number) => void) | undefined,
		label: string,
		pregatedChunks?: AudioChunk[]
	): Promise<ControllerResult> {
		const cfg = this.config;
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
		// The vendored engine only emits progress when a tracker is supplied and
		// its getCurrentTask() is non-null; our headless tracker keeps a live
		// task and forwards the engine's unified percentage to the caller.
		const tracker = onProgress ? new ProgressTracker(onProgress) : undefined;
		const controller = new TranscriptionController(this.app, settings, tracker);
		const t0 = perfNow();
		const modelLabel = cfg.modelOverride
			? `${cfg.model}→${cfg.modelOverride}`
			: cfg.model;
		// console.warn (not .info/.debug) so the line is visible in Obsidian's
		// console without switching on Verbose — matches the vendored Logger.
		// An empty array is truthy, so gate on length: zero pre-gated chunks
		// would transcribe nothing with no fallback. buildPregatedChunks never
		// returns [] (it returns null for "no chunks"), but this keeps the seam
		// safe if a future caller passes one.
		const usePregated = pregatedChunks !== undefined && pregatedChunks.length > 0;
		const source = usePregated
			? `pregated=${pregatedChunks?.length ?? 0}`
			: `vad=${vadMode}`;
		console.warn(
			`[Meeting Copilot][transcribe] ${label} pass start (model=${modelLabel}, ${source}, postproc=${cfg.postProcessingEnabled}, dict=${cfg.dictionaryCorrectionEnabled})`
		);
		try {
			const result = usePregated && pregatedChunks
				? await controller.transcribeChunks(pregatedChunks, signal)
				: await controller.transcribe(file, undefined, undefined, signal);
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

	/**
	 * Decode one mono stream and slice it to just its speech windows, returning
	 * upload-ready chunks whose `startTime` carries the ABSOLUTE original-timeline
	 * offset (so the Whisper client maps returned segment times back onto the
	 * shared me/them clock — no post-mapping needed).
	 *
	 * Returns null — "run a full pass instead" — when nothing survives planning,
	 * when the plan wouldn't reduce the request count (a talk-dense stream
	 * fragments into more chunks than a full pass), or when decoding fails. This
	 * mirrors the existing "empty windows = keep all" safety in the merge.
	 */
	private async buildPregatedChunks(
		file: TFile,
		streamWindows: Array<[number, number]>,
		source: SpeechWindowSource,
		signal?: AbortSignal
	): Promise<AudioChunk[] | null> {
		if (streamWindows.length === 0) {
			return null;
		}
		try {
			const { audioData, sampleRate } = await decodeMono16k(this.app, file);
			if (signal?.aborted) {
				throw new DOMException("Transcription aborted", "AbortError");
			}
			const totalDuration = audioData.length / sampleRate;
			// The plan is sized from the model *family* config (chunk/overlap); a
			// `modelOverride` may rename the request target but not its chunking
			// contract — the same assumption the vendored AudioPipeline chunking
			// already makes, kept in parity here.
			const modelConfig = getModelConfig(this.config.model);
			const overlapDuration = modelConfig.vadChunking.overlapDurationSeconds;
			const padding =
				source === "rms"
					? PREGATE_PADDING_RMS_SECONDS
					: PREGATE_PADDING_VAD_SECONDS;
			const ranges = planPregatedChunks(streamWindows, totalDuration, {
				padding,
				maxChunkDuration: modelConfig.chunkDurationSeconds,
				overlap: overlapDuration,
				mergeGap: PREGATE_MERGE_GAP_SECONDS,
				minChunkDuration: PREGATE_MIN_CHUNK_SECONDS,
				minStandaloneDuration: PREGATE_MIN_STANDALONE_SECONDS,
			});
			if (ranges.length === 0) return null;
			// Non-regressive guard: a talk-dense stream fragments into per-turn
			// windows that can plan MORE requests than a full pass would — and
			// request count, not bytes, drives per-call overhead and the
			// inter-batch rate-limit stalls. When pre-gating wouldn't cut the
			// request count, run the full pass instead.
			const fullPassChunks = estimateFullPassChunkCount(
				totalDuration,
				modelConfig.chunkDurationSeconds,
				overlapDuration
			);
			if (ranges.length >= fullPassChunks) {
				console.warn(
					`[Meeting Copilot][transcribe] pre-gate ${file.name}: plan (${ranges.length} chunks) ` +
						`>= full pass (~${fullPassChunks}); using a full pass`
				);
				return null;
			}
			const bounds = rangesToChunkBounds(ranges, sampleRate, audioData.length);
			if (bounds.length === 0) return null;
			const chunks: AudioChunk[] = bounds.map((b, i) => {
				// subarray is a view (no copy); encodeWavFromFloat32 reads it once.
				const pcm = audioData.subarray(b.startSample, b.endSample);
				// A chunk truly overlaps the previous one only when it was split off
				// the same continuous speech region (adjacent regions don't overlap).
				const prev = i > 0 ? bounds[i - 1] : undefined;
				const hasOverlap = prev ? b.startTime < prev.endTime : false;
				return {
					id: i,
					data: encodeWavFromFloat32(pcm, sampleRate),
					// Absolute offset of the sliced audio, so WhisperClient maps
					// each segment time back onto the original stream clock.
					startTime: b.startTime,
					endTime: b.endTime,
					hasOverlap,
					overlapDuration: hasOverlap ? overlapDuration : 0,
				};
			});
			// Two metrics: uploaded seconds (sum of chunk durations, overlap
			// counted per chunk = what's actually sent and billed) and distinct
			// coverage (union of ranges = timeline touched). Silence-skipped is
			// off coverage so it can't read negative when split overlap inflates
			// the upload.
			const uploadedSecs = plannedSpeechSeconds(ranges);
			const coverageSecs = plannedCoverageSeconds(ranges);
			const skippedPct =
				totalDuration > 0
					? Math.max(0, (1 - coverageSecs / totalDuration) * 100)
					: 0;
			console.warn(
				`[Meeting Copilot][transcribe] pre-gate ${file.name} (windows=${source}): ` +
					`${chunks.length} chunk(s), ${uploadedSecs.toFixed(1)}s uploaded / ` +
					`${coverageSecs.toFixed(1)}s covered of ${totalDuration.toFixed(1)}s ` +
					`(${skippedPct.toFixed(0)}% silence skipped)`
			);
			return chunks;
		} catch (error) {
			// A user cancellation must propagate, not be swallowed into a full
			// pass (which would keep transcribing after the user aborted).
			if (isDiarizationCancelled(error, signal)) throw error;
			// A decode/slice failure must not fail the pass: fall back to a full
			// pass, mirroring computeSpeechWindows swallowing decode errors.
			console.debug(
				"[Meeting Copilot][transcribe] pre-gate unavailable; using a full pass",
				error
			);
			return null;
		}
	}
}
