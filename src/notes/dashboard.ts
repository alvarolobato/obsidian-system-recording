/** Markers delimiting the plugin-managed Dataview block in the dashboard note. */
export const DASHBOARD_START = "%% meeting-copilot:dashboard %%";
export const DASHBOARD_END = "%% /meeting-copilot:dashboard %%";

/** Fenced code-block language rendered by the plugin's "Needs attention" processor. */
export const ATTENTION_BLOCK_LANG = "meeting-copilot-attention";

/** Escapes a string for safe use as a Dataview `FROM "…"` source. */
function sourceFolder(meetingsFolder: string): string {
	return meetingsFolder.replace(/"/g, "").replace(/\/+$/, "") || "Meetings";
}

/**
 * Builds the managed Dataview block (upcoming / past meetings + open action
 * items) for a meetings folder. Pure so it can be tested without a vault.
 */
export function buildDashboardBlock(meetingsFolder: string): string {
	const folder = sourceFolder(meetingsFolder);
	const cols =
		"TABLE WITHOUT ID file.link AS Meeting, " +
		'dateformat(start, "yyyy-MM-dd HH:mm") AS Date, status AS Status, ' +
		'choice(recording, "🎙️", "") AS Rec';
	return [
		DASHBOARD_START,
		"## Upcoming meetings",
		"```dataview",
		cols,
		`FROM "${folder}"`,
		// Compare against the current instant (`now`, not `date(now)` midnight)
		// so same-day meetings that already ended fall under Past.
		"WHERE (event_id OR meeting_url) AND start >= now",
		"SORT start ASC",
		"```",
		"",
		"## Past meetings",
		"```dataview",
		cols,
		`FROM "${folder}"`,
		"WHERE (event_id OR meeting_url) AND start < now",
		"SORT start DESC",
		"```",
		"",
		"## Open action items",
		"```dataview",
		"TASK",
		`FROM "${folder}"`,
		"WHERE !completed",
		"GROUP BY file.link",
		"```",
		"",
		"## Needs attention",
		// Rendered by the plugin: meetings that haven't finished the
		// scheduled → recorded → transcribed → enriched pipeline, with buttons.
		"```" + ATTENTION_BLOCK_LANG,
		"```",
		DASHBOARD_END,
	].join("\n");
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Inserts or replaces the managed dashboard block in existing content, leaving
 * anything the user added around the markers untouched. Pure/testable.
 */
export function withDashboardBlock(content: string, block: string): string {
	const re = new RegExp(
		`${escapeRegExp(DASHBOARD_START)}[\\s\\S]*?${escapeRegExp(DASHBOARD_END)}`
	);
	if (re.test(content)) return content.replace(re, block);
	const trimmed = content.replace(/\s+$/, "");
	return `${trimmed.length ? `${trimmed}\n\n` : ""}${block}\n`;
}
