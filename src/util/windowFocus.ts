/**
 * Deciding whether Obsidian's window is actually frontmost and visible — the
 * gate for the notification channel: when it *is*, an in-app notice will be
 * seen, so a duplicate native banner is skipped; when it *isn't*, the native OS
 * notification is added.
 *
 * The raw signal-gathering (reading `electron.remote` / the DOM) lives in
 * `main.ts` because it touches host globals; the pure decision lives here so it
 * can be unit-tested exhaustively.
 */

/** Electron `BrowserWindow` state, sampled when `electron.remote` is reachable. */
export interface BrowserWindowState {
	isFocused: boolean;
	isMinimized: boolean;
	isVisible: boolean;
}

/** Raw window-focus signals gathered from Electron (when reachable) and the DOM. */
export interface WindowFocusSignals {
	/** Electron `BrowserWindow` state, or `null` when `electron.remote` isn't reachable. */
	win: BrowserWindowState | null;
	/** `document.visibilityState` ("visible" / "hidden" / "n/a" when there's no document). */
	visibilityState: string;
	/** `document.hasFocus()`. */
	hasFocus: boolean;
}

/**
 * True when Obsidian's window is frontmost and visible. Prefers Electron's
 * reliable `BrowserWindow` state (frontmost *and* not minimized *and* shown);
 * falls back to the DOM's focus + visibility when `remote` isn't reachable.
 */
export function decideWindowFocused(signals: WindowFocusSignals): boolean {
	if (signals.win) {
		return (
			signals.win.isFocused &&
			!signals.win.isMinimized &&
			signals.win.isVisible
		);
	}
	return signals.visibilityState === "visible" && signals.hasFocus;
}
