import { isAdhocId, sanitizeName } from "../notes/meetingNote";

/** Inputs for deciding whether to offer an AI title after enrich. */
export interface ShouldSuggestAdhocTitleInput {
	/** Whether the setting is on. */
	suggestAdhocTitle: boolean;
	/** Frontmatter `event_id` already in hand (avoid a post-write metadataCache race). */
	eventId: unknown;
	/** Frontmatter `mc_title_suggested` already in hand. */
	alreadySuggested: unknown;
}

/**
 * Pure gate for the post-enrich ad-hoc title offer. Callers must pass
 * frontmatter values they already read (or just wrote) — not a fresh
 * `metadataCache` lookup that can lag behind `processFrontMatter`.
 */
export function shouldSuggestAdhocTitle(
	input: ShouldSuggestAdhocTitleInput
): boolean {
	if (!input.suggestAdhocTitle) return false;
	if (input.alreadySuggested === true) return false;
	return typeof input.eventId === "string" && isAdhocId(input.eventId);
}

/**
 * Reduces a model-suggested title (from an enrich trailer or a free-form line)
 * to a single filename-safe title.
 */
export function cleanSuggestedTitle(raw: string): string {
	const firstLine = raw.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
	const unquoted = firstLine
		.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
		.replace(/[.。]+$/, "")
		.trim();
	return sanitizeName(unquoted).slice(0, 100).trim();
}
