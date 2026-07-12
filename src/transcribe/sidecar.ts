/**
 * Pure helpers for the split-recording sidecars. With --split the recorder
 * writes three files next to `<base>.<ext>`: `<base>.me.<ext>` (mic),
 * `<base>.them.<ext>` (system audio), and `<base>.speech.json` (per-stream
 * speech windows), where `<ext>` is the recording's own extension (wav or
 * m4a, per the compressed-recordings setting). We locate them by naming
 * convention rather than carrying recorder state, so separation works both
 * for the auto-transcribe right after stop and for a manual re-run on an old
 * recording. No Obsidian imports, so it stays unit-testable.
 */
import type { SpeechWindows } from "./diarize";

/**
 * Recording containers the helper can produce. The single source of truth for
 * the TS side: RecordingFormat (recorder.ts), the sidecar regexes below, the
 * speech.json parent candidates, and the cross-format stem collision check in
 * main.ts are all derived from this list. The Swift mirror is RecordingFormat
 * in AudioMixer.swift.
 */
export const RECORDING_FORMATS = ["wav", "m4a"] as const;
export type RecordingFormat = (typeof RECORDING_FORMATS)[number];

const FORMAT_ALTERNATION = RECORDING_FORMATS.join("|");
const AUDIO_EXT = new RegExp(`\\.(${FORMAT_ALTERNATION})$`, "i");
const SIDECAR_AUDIO = new RegExp(`\\.(me|them)\\.(${FORMAT_ALTERNATION})$`, "i");
const SIDECAR_SPEECH = /\.speech\.json$/i;

export interface SidecarPaths {
	/** Mic-only stream, i.e. the note's author. */
	me: string;
	/** System audio, i.e. everyone else. */
	them: string;
	/** Per-stream speech windows the merge uses to drop ghost segments. */
	speech: string;
}

/** Maps a `<base>.<ext>` recording path to its me/them/speech sidecar paths. */
export function sidecarPathsFor(recordingPath: string): SidecarPaths {
	const match = recordingPath.match(AUDIO_EXT);
	// The audio sidecars share the recording's extension (the helper encodes
	// them with the same writer). Fall back to wav for un-suffixed paths.
	const ext = match?.[1]?.toLowerCase() ?? "wav";
	const base = recordingPath.replace(AUDIO_EXT, "");
	return {
		me: `${base}.me.${ext}`,
		them: `${base}.them.${ext}`,
		speech: `${base}.speech.json`,
	};
}

/** True for a split sidecar (`.me.<ext>`, `.them.<ext>`, or `.speech.json`). */
export function isSidecarPath(path: string): boolean {
	return SIDECAR_AUDIO.test(path) || SIDECAR_SPEECH.test(path);
}

/**
 * The `<base>.<ext>` recording paths a sidecar may belong to, or an empty
 * array if `path` isn't a sidecar. Lets retention tie a sidecar's lifetime to
 * its parent recording: the sidecar is orphaned only when *none* of the
 * candidates exist. Audio sidecars carry the parent's extension, so they have
 * exactly one candidate; `.speech.json` has no extension hint, so it gets one
 * candidate per format the helper can produce.
 */
export function baseRecordingCandidatesOf(path: string): string[] {
	// Keep the matched extension's own case: vault lookups are case-sensitive,
	// so a lowercased candidate would miss a manually renamed `foo.WAV` and
	// the orphan sweep would trash its live sidecar. (The helper itself always
	// writes lowercase; speech.json candidates below stay lowercase because
	// they carry no case hint of their own.)
	const ext = path.match(SIDECAR_AUDIO)?.[2];
	if (ext) {
		return [`${path.replace(SIDECAR_AUDIO, "")}.${ext}`];
	}
	if (SIDECAR_SPEECH.test(path)) {
		const stem = path.replace(SIDECAR_SPEECH, "");
		return RECORDING_FORMATS.map((fmt) => `${stem}.${fmt}`);
	}
	return [];
}

function isWindowList(v: unknown): v is Array<[number, number]> {
	return (
		Array.isArray(v) &&
		v.every(
			(pair) =>
				Array.isArray(pair) &&
				pair.length === 2 &&
				typeof pair[0] === "number" &&
				typeof pair[1] === "number" &&
				Number.isFinite(pair[0]) &&
				Number.isFinite(pair[1])
		)
	);
}

/**
 * Parses the speech.json into {@link SpeechWindows}, or returns undefined when
 * the JSON is missing a valid `me`/`them` window list. Undefined tells the merge
 * to keep every segment, so a malformed sidecar degrades to "no filtering"
 * rather than silently dropping speech.
 */
export function parseSpeechWindows(raw: string): SpeechWindows | undefined {
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!json || typeof json !== "object") return undefined;
	const { me, them } = json as { me?: unknown; them?: unknown };
	if (!isWindowList(me) || !isWindowList(them)) return undefined;
	return { me, them };
}
