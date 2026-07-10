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
 * spellings can share one target with `a | b => correct`.
 *
 * The engine picks a dictionary by the transcription language (and only merges
 * `en`+`ja`+`zh` when language is `auto`), so a rule stored under one language
 * would silently not apply under another. The rules here are language-agnostic
 * name/term fixes, so they're added to every bucket to work for any language.
 */
export function parseDictionary(raw: string): LanguageDictionaries {
	const dict = empty();
	if (!raw) return dict;
	const buckets = [dict.en, dict.ja, dict.zh, dict.ko];
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
		for (const bucket of buckets) {
			bucket.definiteCorrections.push({ from: [...from], to });
		}
	}
	return dict;
}
