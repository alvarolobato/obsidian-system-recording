/**
 * Pure logic for the dashboard's "Needs attention" section: given the state of
 * each meeting note, work out which *recorded* meetings still need the user to
 * do something to finish the recorded → transcribed → enriched pipeline (or
 * have a broken date), and which steps are outstanding. Kept Obsidian-free so
 * it can be unit-tested without a vault.
 */

/** The steps a recorded meeting can still be missing, in pipeline order. */
export type MissingStep = "date" | "transcript" | "summary";

export interface AttentionInput {
	path: string;
	title: string;
	/** Parsed `start` (or `date`) from frontmatter; null/invalid when absent. */
	start: Date | null;
	/** Free-form `status` frontmatter (scheduled | recorded | transcribed | enriched). */
	status: string | null;
	/** True when the note links a recording in frontmatter. */
	hasRecording: boolean;
	/**
	 * True while the plugin is already advancing this note on its own —
	 * transcription running or queued, or enrichment in progress. Such notes are
	 * skipped: the work is happening automatically, so there's nothing for the
	 * user to do.
	 */
	processing: boolean;
}

export interface AttentionRow {
	path: string;
	title: string;
	start: Date | null;
	status: string;
	missing: MissingStep[];
}

function validDate(d: Date | null): d is Date {
	return d != null && !Number.isNaN(d.getTime());
}

/**
 * Returns the meeting notes worth surfacing, broken dates first then newest. A
 * note needs attention only when it has a recording to work with *and* isn't
 * already being processed:
 *
 * - No recording ⇒ there's nothing the user can produce (you can't transcribe
 *   or summarize what wasn't captured), so scheduled meetings and un-recorded
 *   past ones are skipped entirely — a missing recording isn't actionable.
 * - Processing ⇒ a transcription that's running/queued, or an enrichment in
 *   progress, is automatic; the note is advancing on its own, so it's skipped.
 *
 * Among the rest, the outstanding steps are a broken date, a missing transcript
 * (recorded but not transcribed), or — once transcribed — a missing summary.
 */
export function computeAttention(items: AttentionInput[]): AttentionRow[] {
	const rows: AttentionRow[] = [];
	for (const it of items) {
		if (!it.hasRecording || it.processing) continue;

		const status = it.status ?? "";
		const transcribed = status === "transcribed" || status === "enriched";
		const enriched = status === "enriched";

		const missing: MissingStep[] = [];
		const dateOk = validDate(it.start);
		if (!dateOk) missing.push("date");
		if (!transcribed) missing.push("transcript");
		else if (!enriched) missing.push("summary");

		if (missing.length === 0) continue;
		rows.push({
			path: it.path,
			title: it.title,
			start: dateOk ? it.start : null,
			status: status || "—",
			missing,
		});
	}
	rows.sort((a, b) => {
		// Broken-date rows (no start) first, then newest meetings.
		const at = a.start?.getTime() ?? Number.POSITIVE_INFINITY;
		const bt = b.start?.getTime() ?? Number.POSITIVE_INFINITY;
		return bt - at;
	});
	return rows;
}
