export interface FilterableEvent {
	summary: string;
	allDay: boolean;
}

/**
 * Google Calendar `eventType` values that are not real meetings and should be
 * dropped from the sync entirely (agenda + auto-record):
 * - "workingLocation" — home/office indicator, e.g. "Home Location: Home"
 * - "outOfOffice" — OOO blocks
 * - "focusTime" — focus-time blocks
 */
const IGNORED_EVENT_TYPES = new Set([
	"workingLocation",
	"outOfOffice",
	"focusTime",
]);

/** True for event types we treat as meetings; unknown/undefined types are kept. */
export function isMeetingEventType(eventType: string | undefined): boolean {
	return !eventType || !IGNORED_EVENT_TYPES.has(eventType);
}

/** Splits a free-text keyword box (newlines and/or commas) into trimmed, non-empty keywords. */
export function parseKeywords(raw: string): string[] {
	return raw
		.split(/[\n,]/)
		.map((k) => k.trim())
		.filter((k) => k.length > 0);
}

/** True if the title contains any of the (non-blank) exclusion keywords, case-insensitively. */
export function matchesExclusionKeyword(
	summary: string,
	exclusionKeywords: string[]
): boolean {
	const title = summary.toLowerCase();
	return exclusionKeywords.some((k) => {
		const kw = k.trim().toLowerCase();
		return kw.length > 0 && title.includes(kw);
	});
}

/**
 * Records every timed event whose title does NOT contain any exclusion keyword.
 * All-day events are never recorded.
 */
export function shouldRecord(event: FilterableEvent, exclusionKeywords: string[]): boolean {
	if (event.allDay) return false;
	return !matchesExclusionKeyword(event.summary, exclusionKeywords);
}
