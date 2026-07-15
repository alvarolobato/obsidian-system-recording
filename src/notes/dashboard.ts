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
 * `cssclasses` value the Create-dashboard command stamps on the dashboard note
 * so `styles.css` can let it use the full editor width (readable line length
 * off) and render its tables densely. Kept here so the frontmatter writer and
 * the stylesheet agree on the string.
 */
export const DASHBOARD_CSS_CLASS = "meeting-copilot-dashboard";

/**
 * Builds the managed dashboard block. Every section is plugin-rendered — not
 * Dataview — so each can offer a per-page dropdown + pagination and richer
 * layout than a `TABLE`/`TASK` query allows. "Upcoming"/"Past meetings" merge
 * the vault's meeting notes with the calendar events the agenda already loads
 * (meetings with no note yet still appear, with a "create note" action). "Open
 * action items" lists every note's open tasks vault-wide, newest note first.
 * "Needs attention" surfaces recorded meetings that still need transcription
 * or enrichment (plus notes with a broken/missing date) — scheduled meetings
 * with no recording, and ones already transcribing/enriching, are skipped.
 * Pure so it can be tested without a vault.
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
		// Rendered by the plugin: recorded meetings that still need
		// transcription/enrichment (auto-handled ones are skipped), with
		// buttons. Scheduled-but-unrecorded meetings aren't actionable here.
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
