// Portions adapted from obsidian-meetings-plus (0BSD)
// https://github.com/jabaho9523/obsidian-meetings-plus
// See THIRD_PARTY_NOTICES.md.

/** Known conferencing providers, matched against free-text (location/description). */
const PROVIDER_PATTERNS: RegExp[] = [
	/https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"'<>]+/i,
	/https:\/\/[a-z0-9.-]*zoom\.us\/j\/[^\s"'<>]+/i,
	/https:\/\/meet\.google\.com\/[a-z0-9-]+(?:\?[^\s"'<>]*)?/i,
	/https:\/\/[a-z0-9.-]*webex\.com\/(?:meet|wbxmjs|join)\/[^\s"'<>]+/i,
];

/**
 * Best-effort fallback used only when the structured conferenceData/hangoutLink
 * is absent: scans free-text fields for a known meeting-provider URL.
 * Deliberately does NOT fall back to a generic URL match to avoid grabbing
 * unrelated links (docs, agendas) from the description.
 */
export function extractMeetingUrlFromText(
	...texts: Array<string | null | undefined>
): string | null {
	for (const text of texts) {
		if (!text) continue;
		for (const re of PROVIDER_PATTERNS) {
			const m = text.match(re);
			if (m) return m[0];
		}
	}
	return null;
}
