/**
 * Pure logic for the dashboard's "Open action items" section: order the notes
 * that carry open tasks newest-first (by the note's origin date) so the most
 * recent meetings surface at the top. Kept Obsidian-free so it can be
 * unit-tested without a vault; the vault scan (which notes have open tasks, and
 * their text) happens in the plugin, which hands the flattened groups here.
 * Pagination is shared with the meetings tables (see `dashboardMeetings`).
 */

export interface ActionTask {
	/** The task text with the `- [ ]` prefix (and any `✅` date) stripped. */
	text: string;
	/** The full original line, used to locate the task when toggling it done. */
	raw: string;
	/** 0-based line index of the task in its note at scan time. */
	line: number;
	/**
	 * True for a task completed within its grace period (kept in the list a
	 * little longer so a just-ticked item doesn't vanish). Rendered checked and
	 * struck through, and excluded from the "open action items" count.
	 */
	done: boolean;
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

/** Total *open* tasks across all groups (recently-done ones don't count). */
export function countTasks(groups: ActionNoteGroup[]): number {
	return groups.reduce(
		(sum, g) => sum + g.tasks.filter((task) => !task.done).length,
		0
	);
}

const OPEN_TASK_RE = /^\s*[-*+]\s+\[ \]/;
const DONE_TASK_RE = /^\s*[-*+]\s+\[[xX]\]/;
const DONE_DATE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;

/**
 * The display text for a task line, stripping — in order — the list marker +
 * checkbox, a trailing block reference (`^id`, which Obsidian pins to the very
 * end, after the completion date), then the `✅ YYYY-MM-DD` completion date now
 * left at the end. Ref-first means a task completed with a block ref shows
 * neither the date nor the ref in the list.
 */
export function cleanTaskText(raw: string): string {
	return raw
		.replace(/^\s*[-*+]\s+\[[^\]]\]\s*/, "")
		.replace(/\s*\^[A-Za-z0-9-]+\s*$/, "")
		.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}\s*$/, "")
		.trim();
}

/**
 * Parses a note's body into action tasks: every open (`- [ ]`) task, plus any
 * done (`- [x]`) task whose `✅ YYYY-MM-DD` completion date equals `todayStamp`
 * — kept in its grace period until that day is over so a just-ticked item
 * doesn't vanish. Pure/testable; the vault read happens in the plugin.
 */
export function parseNoteTasks(
	content: string,
	todayStamp: string
): ActionTask[] {
	const tasks: ActionTask[] = [];
	content.split("\n").forEach((raw, line) => {
		if (OPEN_TASK_RE.test(raw)) {
			tasks.push({ line, raw, text: cleanTaskText(raw), done: false });
			return;
		}
		if (DONE_TASK_RE.test(raw)) {
			const m = raw.match(DONE_DATE_RE);
			if (m && m[1] === todayStamp) {
				tasks.push({ line, raw, text: cleanTaskText(raw), done: true });
			}
		}
	});
	return tasks;
}
