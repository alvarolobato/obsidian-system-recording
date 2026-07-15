import { TFile } from "obsidian";
import {
	initializeI18n,
	initializeTranslations,
} from "./vendor/i18n/index";
import { PathUtils } from "./vendor/utils/PathUtils";
import {
	mergeDiarized,
	type DiarSegment,
	type PregateSource,
	type PregateSources,
	type SpeechWindows,
} from "./diarize";
import { stripHallucinatedLines } from "./hallucination";
import { isDiarizationCancelled } from "./cancellation";
import type {
	JobResult,
	TranscribeJob,
	TranscriptionBackend,
} from "./backend";
import en from "./vendor/i18n/translations/en";
import ja from "./vendor/i18n/translations/ja";
import ko from "./vendor/i18n/translations/ko";
import zh from "./vendor/i18n/translations/zh";

// Re-exported so existing importers (main.ts, tests) keep one import site even
// though the config shape + engine-progress math now live with the backend that
// owns them.
export { normalizeEngineProgress, type TranscribeConfig } from "./OpenAICompatibleBackend";
export { isDiarizationCancelled } from "./cancellation";

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

/**
 * Runs a transcription backend headlessly and returns the transcript text.
 * The mixed (non-diarized) pass: one job over the whole file, server VAD on.
 */
export async function transcribeAudio(
	file: TFile,
	backend: TranscriptionBackend,
	signal?: AbortSignal,
	onProgress?: (percent: number) => void
): Promise<string> {
	const results = await backend.transcribe({
		jobs: [{ id: "single", file, wantSegments: false }],
		signal,
		onProgress,
	});
	// Select by job id rather than position: a backend's result order is not
	// part of the contract (mirrors how the diarized path looks up me/them).
	return results.find((r) => r.id === "single")?.text ?? "";
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
 * Build one diarized stream job. When the good detector produced windows for
 * this stream we pre-gate the upload to them (skipping silence); a stream with
 * no windows, or one the good detector heard nothing on ("none"), runs a full
 * pass so a quiet-but-real speaker is never silently skipped.
 */
function streamJob(
	id: "me" | "them",
	file: TFile,
	streamWindows: Array<[number, number]> | undefined,
	source: PregateSource
): TranscribeJob {
	// A stream the good detector heard nothing on ("none"), or one with no
	// windows, runs a full pass so a quiet-but-real speaker is never skipped.
	if (source === "none" || !streamWindows || streamWindows.length === 0) {
		return { id, file, wantSegments: true };
	}
	// `source` is now narrowed to "vad" | "rms" (= SpeechWindowSource), no cast.
	return { id, file, wantSegments: true, speechWindows: streamWindows, windowSource: source };
}

function segmentsOf(result: JobResult | undefined): DiarSegment[] {
	return result?.segments ?? [];
}

/**
 * Transcribes the two mono sidecar streams (mic = "me", system audio = "them")
 * and merges them into one speaker-labelled transcript on their shared clock.
 *
 * Each stream is *pre-gated* to its detected speech windows (issue #67): we
 * upload only padded speech regions and skip the (usually large) silent gaps,
 * cutting wall-clock time and API cost and starving Whisper of the silence it
 * hallucinates over. Pre-gated chunks carry their absolute original-timeline
 * offset, so segment times still land on the shared clock. `sources` tells each
 * stream which detector produced its windows: a stream with no windows, one the
 * good detector heard nothing on, or one whose plan wouldn't beat a full pass
 * falls back to a full pass, so speech is never silently dropped and the
 * optimization never regresses.
 *
 * Both passes run inside the same serial slot (owned by the backend) as
 * {@link transcribeAudio} so the process-global endpoint seam can't be
 * overwritten mid-flight.
 *
 * If a pass is a capability miss (no segments but real, non-hallucination text,
 * i.e. the endpoint ignored the timestamp request) this resolves with
 * `diarized: false` so the caller can fall back to transcribing the mixed-down
 * file. The `continueAfterJob` hook classifies the me pass before spending a
 * full them pass: on a miss it stops after me (2 passes: me + fallback) instead
 * of running them too (3). A truly silent stream — no segments and either no
 * text or only stock hallucination text — is not a miss and we proceed (see
 * {@link isCapabilityMiss}).
 */
export async function transcribeDiarized(
	meFile: TFile,
	themFile: TFile,
	backend: TranscriptionBackend,
	windows?: SpeechWindows,
	signal?: AbortSignal,
	onProgress?: (percent: number) => void,
	sources?: PregateSources
): Promise<DiarizedResult> {
	const jobs: TranscribeJob[] = [
		streamJob("me", meFile, windows?.me, sources?.me ?? "none"),
		streamJob("them", themFile, windows?.them, sources?.them ?? "none"),
	];
	try {
		const results = await backend.transcribe({
			jobs,
			signal,
			onProgress,
			// Classify the me pass before spending a full them pass: on a
			// capability miss we can't diarize either stream, so stop now.
			continueAfterJob: (r) => !isCapabilityMiss(segmentsOf(r), r.text),
		});
		const me = results.find((r) => r.id === "me");
		const them = results.find((r) => r.id === "them");

		if (me && isCapabilityMiss(segmentsOf(me), me.text)) {
			return { text: "", diarized: false, reason: "capability" };
		}
		// them absent means the backend stopped early (only happens on a me
		// capability miss, handled above) — or the me pass didn't run at all.
		// Either way there's nothing to diarize; fall back to the mixed file.
		if (!me || !them) {
			return { text: "", diarized: false, reason: "error" };
		}
		if (isCapabilityMiss(segmentsOf(them), them.text)) {
			return { text: "", diarized: false, reason: "capability" };
		}

		// Both passes honored timestamps. A stream empty here is legitimately
		// silent; mergeDiarized handles one empty side, and two give "".
		return {
			text: mergeDiarized(segmentsOf(me), segmentsOf(them), windows),
			diarized: true,
		};
	} catch (error) {
		if (isDiarizationCancelled(error, signal)) {
			throw error;
		}
		// A partial mono pass throws the partial-marker text (one flaky chunk).
		// That must not kill the whole transcription: the mixed wav can still be
		// transcribed, so warn and let the caller fall back to it rather than
		// letting the throw escape and leave no transcript written.
		console.warn("Diarized transcription pass failed; falling back to mixed file", error);
		return { text: "", diarized: false, reason: "error" };
	}
}
