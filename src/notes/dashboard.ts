/** Markers delimiting the plugin-managed Dataview block in the dashboard note. */
export const DASHBOARD_START = "%% meeting-copilot:dashboard %%";
export const DASHBOARD_END = "%% /meeting-copilot:dashboard %%";

/** Fenced code-block language rendered by the plugin's "Needs attention" processor. */
export const ATTENTION_BLOCK_LANG = "meeting-copilot-attention";

/** Fenced code-block language rendered by the plugin's paginated "Upcoming meetings" processor. */
export const UPCOMING_BLOCK_LANG = "meeting-copilot-upcoming";

/** Fenced code-block language rendered by the plugin's paginated "Past meetings" processor. */
export const PAST_BLOCK_LANG = "meeting-copilot-past";

/** Fenced code-block language rendered by the plugin's paginated "Open action items" processor. */
export const ACTIONS_BLOCK_LANG = "meeting-copilot-actions";

/**
 * Builds the managed dashboard block. Every section is plugin-rendered — not
 * Dataview — so each can offer a per-page dropdown + pagination and richer
 * layout than a `TABLE`/`TASK` query allows. "Upcoming"/"Past meetings" merge
 * the vault's meeting notes with the calendar events the agenda already loads
 * (meetings with no note yet still appear, with a "create note" action). "Open
 * action items" lists every note's open tasks vault-wide, newest note first.
 * "Needs attention" surfaces meetings that haven't finished the pipeline. Pure
 * so it can be tested without a vault.
 */
export function buildDashboardBlock(): string {
	return [
		DASHBOARD_START,
		"## Upcoming meetings",
		// Rendered by the plugin: calendar events + noted meetings, soonest
		// first, with a per-page dropdown and pagination.
		"```" + UPCOMING_BLOCK_LANG,
		"```",
		"",
		"## Past meetings",
		// Rendered by the plugin: calendar events + noted meetings, newest
		// first, with a per-page dropdown and pagination.
		"```" + PAST_BLOCK_LANG,
		"```",
		"",
		"## Open action items",
		// Rendered by the plugin: open tasks from every note in the vault,
		// grouped by note (newest first), dense and paginated.
		"```" + ACTIONS_BLOCK_LANG,
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
