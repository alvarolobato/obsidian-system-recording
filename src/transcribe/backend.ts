/**
 * The pluggable transcription backend seam.
 *
 * `TranscriptionService` is a backend-agnostic *orchestrator* (diarized pass,
 * capability-miss classification, merge, probe invalidation); the actual
 * transcription — endpoint config, chunking, progress, partial detection — is
 * owned by a `TranscriptionBackend`. Today the only implementation is
 * {@link ./OpenAICompatibleBackend} (the vendored engine + serial queue +
 * process-global endpoint seam, all hidden inside it); a local on-device
 * backend (issue #34) drops in against this same interface.
 *
 * Endpoint/model/language/dictionary config is a property of a *backend
 * instance* (constructed once from settings), not of a per-call request — so a
 * request carries only the per-call work (which files, progress, cancellation).
 */
import type { TFile } from "obsidian";
import type { DiarSegment, PregateSource } from "./diarize";

/**
 * How a job's speech windows were derived, so a backend can pick padding.
 * Tied to {@link PregateSource} minus its "no windows" case ("none"), so the
 * two never drift: a job either carries usable windows ("vad" | "rms") or none.
 */
export type SpeechWindowSource = Exclude<PregateSource, "none">;

/** One audio file to transcribe within a request. */
export interface TranscribeJob {
	/** Stable id echoed back on the result ("mixed" | "me" | "them"). */
	id: string;
	file: TFile;
	/** Diarized passes need timestamped segments; the mixed pass doesn't. */
	wantSegments: boolean;
	/**
	 * Speech time-ranges (absolute seconds on the file's own clock) to restrict
	 * transcription to, skipping silence (pre-gating, issue #67). Whole file
	 * when omitted. Segment times are ALWAYS on the file's own clock.
	 */
	speechWindows?: Array<[number, number]>;
	/** How {@link speechWindows} were derived, so the backend can size padding. */
	windowSource?: SpeechWindowSource;
}

/**
 * Typed partial marker for a job that only partially transcribed. Reserved for
 * backends that surface partials as data (the local backend will); the
 * OpenAI-compatible backend still propagates partials through the vendored
 * engine's marker-in-text / thrown-error contract, so it does not set this yet.
 */
export interface PartialInfo {
	processedChunks: number;
	totalChunks: number;
	reason: string;
}

/** The transcription of a single {@link TranscribeJob}. */
export interface JobResult {
	id: string;
	text: string;
	/** Present when `wantSegments` was set and the backend produced segments. */
	segments?: DiarSegment[];
	/** See {@link PartialInfo}; unset by the OpenAI-compatible backend today. */
	partial?: PartialInfo;
}

export interface TranscribeRequest {
	jobs: TranscribeJob[];
	/** 0–100 for the whole request; the backend weights the bar across jobs. */
	onProgress?: (percent: number) => void;
	signal?: AbortSignal;
	/**
	 * Consulted between sequential jobs: return `false` after a job's result to
	 * stop early and return the results gathered so far, skipping the remaining
	 * jobs. The diarized orchestrator uses this to skip the second (them) pass
	 * when the first (me) pass is a capability miss — preserving today's "don't
	 * spend a doomed second pass" behavior. Defaults to "always continue".
	 *
	 * This is purely an optimization hook: a backend that runs all jobs in one
	 * batch (e.g. a local helper that decodes both passes in a single process)
	 * MAY ignore it. The orchestrator re-classifies every returned result after
	 * the loop, so skipping the hook only forfeits the early-exit saving, never
	 * correctness.
	 */
	continueAfterJob?: (result: JobResult) => boolean;
}

export interface ValidationResult {
	ok: boolean;
	message?: string;
}

export interface TranscriptionBackend {
	readonly id: "openai-compatible" | "whisper-cpp";
	/** Cheap, side-effect-free; gates the settings toggle and pre-run checks. */
	validateConfig(): Promise<ValidationResult>;
	/**
	 * Transcribe every job in one call (so a local backend can amortize model
	 * load). Jobs run sequentially; progress is reported 0–100 across the whole
	 * request. Throws on cancellation and on unrecoverable failure.
	 */
	transcribe(req: TranscribeRequest): Promise<JobResult[]>;
}

/** Runs one job; `onProgress` is job-local 0–100 (the runner slices the bar). */
export type JobRunner = (
	job: TranscribeJob,
	ctx: { signal?: AbortSignal; onProgress?: (jobPercent: number) => void }
) => Promise<JobResult>;

/**
 * The canonical sequential job loop every backend shares, so the ordering
 * contract can't drift between implementations (and is unit-tested once).
 *
 * Guarantees:
 *   - jobs run in order; job `i` owns the `[i/n, (i+1)/n]` slice of the 0–100
 *     bar (one job fills it end to end; two line up on 0–50 / 50–100);
 *   - a cancellation is checked before each job starts AND after each job
 *     completes (before `continueAfterJob`) — so a cancel between passes
 *     propagates as an AbortError rather than being reclassified by the hook;
 *   - `continueAfterJob` returning false stops early and returns the results
 *     gathered so far (used to skip a doomed second diarized pass).
 */
export async function runJobsSequentially(
	req: TranscribeRequest,
	runJob: JobRunner
): Promise<JobResult[]> {
	const n = req.jobs.length;
	const results: JobResult[] = [];
	for (let i = 0; i < n; i++) {
		const job = req.jobs[i];
		if (!job) continue;
		if (req.signal?.aborted) {
			throw new DOMException("Transcription aborted", "AbortError");
		}
		const base = (i * 100) / n;
		const span = 100 / n;
		const onProgress = req.onProgress
			? (jobPercent: number) => req.onProgress?.(base + (jobPercent * span) / 100)
			: undefined;
		const result = await runJob(job, { signal: req.signal, onProgress });
		results.push(result);
		if (i < n - 1) {
			// Abort BEFORE the early-bail hook, matching the pre-refactor order:
			// a cancellation between passes must propagate, not be reclassified
			// (e.g. as a capability miss, which would also invalidate the probe).
			if (req.signal?.aborted) {
				throw new DOMException("Transcription aborted", "AbortError");
			}
			if (req.continueAfterJob && !req.continueAfterJob(result)) {
				break;
			}
		}
	}
	return results;
}
