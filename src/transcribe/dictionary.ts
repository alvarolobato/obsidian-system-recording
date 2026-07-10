import type { LanguageDictionaries } from "./vendor/ApiSettings";

function empty(): LanguageDictionaries {
	return {
		ja: { definiteCorrections: [], contextualCorrections: [] },
		en: { definiteCorrections: [], contextualCorrections: [] },
		zh: { definiteCorrections: [], contextualCorrections: [] },
		ko: { definiteCorrections: [], contextualCorrections: [] },
	};
}

/**
 * Parses the user's plain-text dictionary into the vendored engine's structure.
 *
 * Each non-empty, non-comment line is `misheard => correct`. Multiple source
 * spellings can share one target with `a | b => correct`. Rules are stored as
 * English `definiteCorrections` (the engine applies them post-transcription).
 */
export function parseDictionary(raw: string): LanguageDictionaries {
	const dict = empty();
	if (!raw) return dict;
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const idx = trimmed.indexOf("=>");
		if (idx === -1) continue;
		const to = trimmed.slice(idx + 2).trim();
		const from = trimmed
			.slice(0, idx)
			.split("|")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		if (from.length === 0 || !to) continue;
		dict.en.definiteCorrections.push({ from, to });
	}
	return dict;
}
