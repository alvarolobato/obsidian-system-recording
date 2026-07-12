/** Markers delimiting the plugin-managed Dataview block in the dashboard note. */
export const DASHBOARD_START = "%% meeting-copilot:dashboard %%";
export const DASHBOARD_END = "%% /meeting-copilot:dashboard %%";

/** Fenced code-block language rendered by the plugin's "Needs attention" processor. */
export const ATTENTION_BLOCK_LANG = "meeting-copilot-attention";

/**
 * Builds the managed Dataview block (upcoming / past meetings + open action
 * items). Deliberately vault-wide — no `FROM` — since meeting notes can live
 * under any of several folders (per-series, per-1:1, ad-hoc, or wherever the
 * user moved them); scoping to one folder would miss most of them. Queries
 * match `event_id` (plugin-owned) or `meeting_url` (legacy/manual meeting
 * notes the pre-template dashboard also listed). The task query reads the
 * fields via `file.frontmatter` because tasks stopped inheriting page fields
 * in newer Dataview releases. Pure so it can be tested without a vault.
 */
export function buildDashboardBlock(): string {
	const cols =
		"TABLE WITHOUT ID file.link AS Meeting, " +
		'dateformat(start, "yyyy-MM-dd HH:mm") AS Date, status AS Status, ' +
		'choice(recording, "🎙️", "") AS Rec';
	return [
		DASHBOARD_START,
		"## Upcoming meetings",
		"```dataview",
		cols,
		// Compare against the current instant (`now`, not `date(now)` midnight)
		// so same-day meetings that already ended fall under Past.
		"WHERE (event_id OR meeting_url) AND start >= now",
		"SORT start ASC",
		"```",
		"",
		"## Past meetings",
		"```dataview",
		cols,
		"WHERE (event_id OR meeting_url) AND start < now",
		"SORT start DESC",
		"```",
		"",
		"## Open action items",
		"```dataview",
		"TASK WHERE !completed AND (file.frontmatter.event_id OR file.frontmatter.meeting_url)",
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
