/**
 * Pure logic for the dashboard's "Open action items" section: order the notes
 * that carry open tasks newest-first (by the note's origin date) so the most
 * recent meetings surface at the top. Kept Obsidian-free so it can be
 * unit-tested without a vault; the vault scan (which notes have open tasks, and
 * their text) happens in the plugin, which hands the flattened groups here.
 * Pagination is shared with the meetings tables (see `dashboardMeetings`).
 */

export interface ActionTask {
	/** The task text with the `- [ ]` prefix stripped (may contain markdown). */
	text: string;
	/** The full original line, used to locate the task when toggling it done. */
	raw: string;
	/** 0-based line index of the task in its note at scan time. */
	line: number;
}

export interface ActionNoteGroup {
	path: string;
	title: string;
	/** The note's origin date (frontmatter/filename/mtime); null when unknown. */
	date: Date | null;
	tasks: ActionTask[];
}

/**
 * Returns the groups that actually have open tasks, ordered by note date
 * (newest first). Groups without a date sort last, and ties break on the path
 * so the order is stable rather than dependent on scan order.
 */
export function sortActionNoteGroups(
	groups: ActionNoteGroup[]
): ActionNoteGroup[] {
	return groups
		.filter((g) => g.tasks.length > 0)
		.sort((a, b) => {
			const at = a.date?.getTime() ?? Number.NEGATIVE_INFINITY;
			const bt = b.date?.getTime() ?? Number.NEGATIVE_INFINITY;
			if (bt !== at) return bt - at;
			return a.path.localeCompare(b.path);
		});
}

/** Total open tasks across all groups (for the section's count label). */
export function countTasks(groups: ActionNoteGroup[]): number {
	return groups.reduce((sum, g) => sum + g.tasks.length, 0);
}
