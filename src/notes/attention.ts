/**
 * Pure logic for the dashboard's "Needs attention" section: given the state of
 * each meeting note, work out which ones haven't finished the
 * scheduled → recorded → transcribed → enriched pipeline (or have a data
 * problem), and which steps are still missing. Kept Obsidian-free so it can be
 * unit-tested without a vault.
 */

/** The steps a meeting note can still be missing, in pipeline order. */
export type MissingStep = "date" | "recording" | "transcript" | "summary";

export interface AttentionInput {
	path: string;
	title: string;
	/** Parsed `start` (or `date`) from frontmatter; null/invalid when absent. */
	start: Date | null;
	/** Free-form `status` frontmatter (scheduled | recorded | transcribed | enriched). */
	status: string | null;
	/** True when the note links a recording in frontmatter. */
	hasRecording: boolean;
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
 * Returns the incomplete meeting notes worth surfacing, newest first. A note is
 * surfaced when it is missing a pipeline step AND is actionable — i.e. it has
 * already happened, has a recording to work with, or has a broken date. Clean
 * future meetings (scheduled, nothing recorded yet) are intentionally skipped.
 */
export function computeAttention(
	items: AttentionInput[],
	now: Date
): AttentionRow[] {
	const rows: AttentionRow[] = [];
	for (const it of items) {
		const missing: MissingStep[] = [];
		const dateOk = validDate(it.start);
		if (!dateOk) missing.push("date");

		const status = it.status ?? "";
		const transcribed = status === "transcribed" || status === "enriched";
		const enriched = status === "enriched";

		if (!it.hasRecording) missing.push("recording");
		else if (!transcribed) missing.push("transcript");
		if (!enriched) missing.push("summary");

		const isPast =
			validDate(it.start) && it.start.getTime() < now.getTime();
		const actionable = isPast || it.hasRecording || !dateOk;
		if (missing.length > 0 && actionable) {
			rows.push({
				path: it.path,
				title: it.title,
				start: dateOk ? it.start : null,
				status: status || "—",
				missing,
			});
		}
	}
	rows.sort((a, b) => {
		// Broken-date rows first, then newest meetings.
		const at = a.start?.getTime() ?? Number.POSITIVE_INFINITY;
		const bt = b.start?.getTime() ?? Number.POSITIVE_INFINITY;
		return bt - at;
	});
	return rows;
}
