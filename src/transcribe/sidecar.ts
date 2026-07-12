/**
 * Pure helpers for the split-recording sidecars. With --split the recorder
 * writes three files next to `<base>.wav`: `<base>.me.wav` (mic), `<base>.them.wav`
 * (system audio), and `<base>.speech.json` (per-stream speech windows). We locate
 * them by naming convention rather than carrying recorder state, so separation
 * works both for the auto-transcribe right after stop and for a manual re-run on
 * an old recording. No Obsidian imports, so it stays unit-testable.
 */
import type { SpeechWindows } from "./diarize";

export interface SidecarPaths {
	/** Mic-only stream, i.e. the note's author. */
	me: string;
	/** System audio, i.e. everyone else. */
	them: string;
	/** Per-stream speech windows the merge uses to drop ghost segments. */
	speech: string;
}

/** Maps a `<base>.wav` recording path to its me/them/speech sidecar paths. */
export function sidecarPathsFor(recordingPath: string): SidecarPaths {
	const base = recordingPath.replace(/\.wav$/i, "");
	return {
		me: `${base}.me.wav`,
		them: `${base}.them.wav`,
		speech: `${base}.speech.json`,
	};
}

/** True for a split sidecar (`.me.wav`, `.them.wav`, or `.speech.json`). */
export function isSidecarPath(path: string): boolean {
	return /\.(me|them)\.wav$/i.test(path) || /\.speech\.json$/i.test(path);
}

/**
 * The `<base>.wav` recording a sidecar belongs to, or null if `path` isn't a
 * sidecar. Lets retention tie a sidecar's lifetime to its parent recording.
 */
export function baseRecordingPathOf(path: string): string | null {
	const stripped = path
		.replace(/\.(me|them)\.wav$/i, "")
		.replace(/\.speech\.json$/i, "");
	return stripped === path ? null : `${stripped}.wav`;
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
