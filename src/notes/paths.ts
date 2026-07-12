import { normalizePath } from "obsidian";

// Characters Obsidian/most filesystems reject in file names, plus wikilink-hostile ones.
const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;

/**
 * Makes a string safe to use as a single file or folder name (never a path).
 * Leading/trailing dots and spaces are stripped after that: a lone "." or
 * ".." would otherwise collapse into the 1:1 root or a scan root, trailing
 * dots break Windows folder names, and a leading dot makes an Obsidian-hidden
 * folder.
 */
export function sanitizeName(name: string): string {
	const cleaned = name
		.replace(ILLEGAL, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^[.\s]+/, "")
		.replace(/[.\s]+$/, "");
	return cleaned || "Untitled";
}

/** True for a folder segment that is empty, or made up only of dots ("", ".", "..", "..."), once trimmed. */
function isDotsOnly(segment: string): boolean {
	return /^\.*$/.test(segment.trim());
}

/**
 * Splits a path on "/", sanitizing each segment and dropping any that are
 * empty or only dots, so a value carrying "/", ".", or ".." can never inject
 * an extra folder or walk outside the intended root. Returns "" when nothing
 * is left — use this over `normalizeFolderPath` when claiming a fallback
 * folder would be wrong (e.g. scoping a scan or a retention sweep).
 */
export function normalizeFolderPathOrEmpty(input: string): string {
	const segments = input
		.trim()
		.replace(/\/+$/, "")
		.split("/")
		.filter((s) => !isDotsOnly(s))
		.map((s) => sanitizeName(s));
	const joined = segments.join("/");
	return joined.length > 0 ? normalizePath(joined) : "";
}

/**
 * Normalizes a user- or template-rendered folder path (see
 * `normalizeFolderPathOrEmpty` above), falling back to "Meetings" when
 * nothing is left.
 */
export function normalizeFolderPath(input: string): string {
	return normalizeFolderPathOrEmpty(input) || "Meetings";
}

/**
 * The literal, token-free prefix of a folder template (e.g. "Meetings" from
 * "Meetings/{{year}}"), for callers that need a single stable folder to scope
 * a scan to rather than resolving a specific event's folder. Truncated to the
 * last *complete* segment before the first token, so "Meetings/Q{{year}}"
 * yields "Meetings" rather than "Meetings/Q" (which would match nothing —
 * notes actually land in "Meetings/Q2026"). Returns "" when the template
 * starts with a token, or when the token is mid-segment with no preceding
 * "/" (e.g. "{{series}}/notes" or "Q{{year}}") — the caller decides its own
 * fallback rather than this silently sweeping "Meetings".
 */
export function templateStaticRoot(template: string): string {
	const idx = template.indexOf("{{");
	if (idx === -1) return normalizeFolderPathOrEmpty(template);
	const prefix = template.slice(0, idx);
	const lastSlash = prefix.lastIndexOf("/");
	return normalizeFolderPathOrEmpty(lastSlash === -1 ? "" : prefix.slice(0, lastSlash));
}
