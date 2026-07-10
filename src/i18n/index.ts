import { en, type Messages } from "./en";

// English is the base language. Additional locales can be added here, e.g.
// `import { de } from "./de"` and `{ en, de }`, and they'll be picked up
// automatically for users whose Obsidian language matches.
const LOCALES: Record<string, Messages> = { en };

/** Obsidian stores the active display language in localStorage under "language". */
function currentLocale(): string {
	try {
		return window.localStorage.getItem("language") || "en";
	} catch {
		return "en";
	}
}

/** Returns the message bundle for the active Obsidian language, falling back to English. */
export function t(): Messages {
	return LOCALES[currentLocale()] ?? en;
}

export type { Messages };
