/**
 * Finds the item whose `path` equals `target` ignoring case — a fallback for
 * Obsidian's case-SENSITIVE {@link import("obsidian").Vault.getAbstractFileByPath}
 * when a vault's folder-case in the *index* differs from the case we derived
 * from settings.
 *
 * This happens on a case-insensitive filesystem (macOS/APFS default, iCloud
 * sync): the recorder writes the audio to the settings-cased path (e.g.
 * `Meetings/…`), but Obsidian may have registered the folder under a different
 * case (`meetings/…`) — so the exact, case-sensitive index lookup misses even
 * though the file is on disk and indexed. The manual "Transcribe from agenda"
 * path already tolerates this because `metadataCache.getFirstLinkpathDest` is
 * case-insensitive; this helper lets the auto-transcribe path match it.
 *
 * Prefers an exact (case-sensitive) match when items differ only by case, so a
 * correctly-cased path is never shadowed by a look-alike.
 */
export function findByPathCaseInsensitive<T extends { path: string }>(
	items: readonly T[],
	target: string
): T | null {
	let ciMatch: T | null = null;
	const lower = target.toLowerCase();
	for (const item of items) {
		if (item.path === target) return item;
		if (ciMatch === null && item.path.toLowerCase() === lower) {
			ciMatch = item;
		}
	}
	return ciMatch;
}
