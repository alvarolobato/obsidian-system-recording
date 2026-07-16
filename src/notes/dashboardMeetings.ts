/**
 * Pure logic for the dashboard's "Upcoming meetings" and "Past meetings"
 * tables: filter a merged list of meeting notes + calendar events into the
 * requested direction, sort it, and paginate. Kept Obsidian-free so it can be
 * unit-tested without a vault. Merging the two sources (deduping calendar
 * events that already have a note) happens in the plugin, which then hands the
 * flattened inputs here.
 */

/** Per-page choices offered by the dashboard dropdown. */
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

/** Default page size when nothing (valid) is persisted. */
export const DEFAULT_PAGE_SIZE = 10;

/** Which side of "now" a table shows. */
export type MeetingDirection = "upcoming" | "past";

export interface DashboardMeetingInput {
	/** Stable dedup/lookup key: `event_id` when known, else the note path. */
	key: string;
	title: string;
	/** Parsed `start` (from the note's frontmatter or the calendar event); null/invalid when absent. */
	start: Date | null;
	/** Free-form note `status`; empty string when there's no note yet. */
	status: string;
	/** True when a recording is linked from the note. */
	hasRecording: boolean;
	/** Vault path of the meeting note, or null for a calendar event with no note yet. */
	notePath: string | null;
}

export interface DashboardMeetingRow {
	key: string;
	title: string;
	start: Date;
	status: string;
	hasRecording: boolean;
	notePath: string | null;
}

export interface Page<T> {
	rows: T[];
	/** 1-based page actually shown, clamped into range. */
	page: number;
	/** Total number of pages (at least 1, even when empty). */
	pageCount: number;
	/** Total rows across all pages. */
	total: number;
}

function validDate(d: Date | null): d is Date {
	return d != null && !Number.isNaN(d.getTime());
}

/**
 * Clamps a persisted per-page value to one of {@link PAGE_SIZE_OPTIONS},
 * falling back to {@link DEFAULT_PAGE_SIZE} for anything missing or invalid
 * (a hand-edited `data.json`, an old option that's no longer offered, etc.).
 */
export function normalizePageSize(n: unknown): number {
	return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n as number)
		? (n as number)
		: DEFAULT_PAGE_SIZE;
}

/**
 * Keeps the rows on the requested side of `now` — past (`start < now`, newest
 * first) or upcoming (`start >= now`, soonest first). Rows without a valid
 * `start` are dropped (they belong to neither bucket). The status falls back to
 * an em dash so a note with none still renders a cell.
 */
export function meetingRows(
	items: DashboardMeetingInput[],
	now: Date,
	direction: MeetingDirection
): DashboardMeetingRow[] {
	const rows: DashboardMeetingRow[] = [];
	for (const it of items) {
		if (!validDate(it.start)) continue;
		const isPast = it.start.getTime() < now.getTime();
		if (direction === "past" && !isPast) continue;
		if (direction === "upcoming" && isPast) continue;
		rows.push({
			key: it.key,
			title: it.title,
			start: it.start,
			status: it.status || "—",
			hasRecording: it.hasRecording,
			notePath: it.notePath,
		});
	}
	rows.sort((a, b) =>
		direction === "past"
			? b.start.getTime() - a.start.getTime()
			: a.start.getTime() - b.start.getTime()
	);
	return rows;
}

/**
 * Slices `rows` into the requested page. `pageSize` is normalized to a valid
 * option; `page` is clamped into `[1, pageCount]` so an out-of-range request
 * (e.g. sitting on page 5 when the list shrinks) resolves to a real page
 * rather than an empty view.
 */
export function paginate<T>(
	rows: T[],
	pageSize: number,
	page: number
): Page<T> {
	const size = normalizePageSize(pageSize);
	const total = rows.length;
	const pageCount = Math.max(1, Math.ceil(total / size));
	const clamped = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
	const start = (clamped - 1) * size;
	return {
		rows: rows.slice(start, start + size),
		page: clamped,
		pageCount,
		total,
	};
}
