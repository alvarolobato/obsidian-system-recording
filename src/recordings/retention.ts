/** Minimal file descriptor so the selection logic stays pure and testable. */
export interface AudioFileInfo {
	path: string;
	/** Lower/upper-case extension without the dot, e.g. "wav". */
	ext: string;
	/** Last-modified time in epoch ms. */
	mtime: number;
}

export interface RetentionConfig {
	/** Only files under one of these folders are eligible. If none resolve to a
	 *  real folder name, nothing is swept (retention is scoped, never vault-wide). */
	folders: string[];
	/** Recordings older than this many days are expired. 0/negative disables cleanup. */
	retentionDays: number;
	/** "Now" in epoch ms. */
	now: number;
	/** Paths that must never be removed (e.g. the in-progress recording). */
	protectedPaths?: Set<string>;
	/** Exact recording paths eligible regardless of `folders` (e.g. a recording
	 *  linked from a meeting note the user moved outside every scoped folder).
	 *  Deliberately path-precise, never a folder: a moved note must not turn
	 *  its new neighborhood into sweepable territory. */
	extraPaths?: Set<string>;
}

const AUDIO_EXTENSIONS = new Set(["wav", "m4a", "mp3", "webm", "ogg", "flac"]);

/** True for extensions we treat as recordings. */
export function isAudioExt(ext: string): boolean {
	return AUDIO_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * True for the split recorder's speech-window sidecar (`<base>.speech.json`).
 * These live beside the audio and are only useful for a re-transcribe, so the
 * sweep ages them out on the same rule rather than leaving them orphaned once
 * diarization has consumed them (or if diarization never succeeds).
 */
export function isSpeechSidecar(path: string): boolean {
	return path.toLowerCase().endsWith(".speech.json");
}

const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeFolder(folder: string): string {
	return folder.trim().replace(/\/+$/, "");
}

/** True if `path` is inside (or equal to) `folder`. */
export function underFolder(path: string, folder: string): boolean {
	if (!folder) return false;
	return path === folder || path.startsWith(`${folder}/`);
}

/**
 * Returns the audio files that are past the retention window and eligible for
 * cleanup. Pure: takes a snapshot of files + config and returns the subset to
 * remove, so it can be unit-tested without a vault.
 */
export function findExpiredRecordings(
	files: AudioFileInfo[],
	cfg: RetentionConfig
): AudioFileInfo[] {
	if (cfg.retentionDays <= 0) return [];
	const folders = cfg.folders.map(normalizeFolder).filter(Boolean);
	const extra = cfg.extraPaths;
	// No valid scope → never sweep (avoid trashing unrelated vault audio).
	if (folders.length === 0 && !extra?.size) return [];
	const cutoff = cfg.now - cfg.retentionDays * DAY_MS;
	return files.filter(
		(f) =>
			(isAudioExt(f.ext) || isSpeechSidecar(f.path)) &&
			f.mtime < cutoff &&
			(folders.some((folder) => underFolder(f.path, folder)) ||
				extra?.has(f.path) === true) &&
			!cfg.protectedPaths?.has(f.path)
	);
}
