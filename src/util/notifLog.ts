/**
 * Lightweight, runtime-toggleable logging for the notification pipeline.
 * **Off by default** (shipped builds stay silent). Enable it live — no rebuild —
 * from the Obsidian DevTools console (Cmd+Opt+I):
 *
 *   localStorage.setItem("mc:notif-debug", "1")   // logging takes effect at once
 *   localStorage.removeItem("mc:notif-debug")      // to turn it back off
 *
 * The flag is read on every `notifLog` call, so tracing starts/stops
 * immediately within a running session. (Only the dev-only "test notification"
 * command in `main.ts` needs an Obsidian reload, since it's registered once at
 * load behind this same flag.)
 *
 * When on it traces which channel a prompt takes (in-app vs native), whether the
 * native path is even available, the raw window-focus signals, and every
 * native/web notification event. Every line is prefixed so it's easy to filter
 * the console with `mc:notif`, and nothing extra reaches end users while it's
 * off.
 */

const DEBUG_KEY = "mc:notif-debug";

/** True when notification tracing is enabled via the `mc:notif-debug` localStorage flag. */
export function notifDebugEnabled(): boolean {
	try {
		return window.localStorage.getItem(DEBUG_KEY) === "1";
	} catch {
		// No window/localStorage (e.g. tests, mobile) — treat as off.
		return false;
	}
}

export function notifLog(event: string, data?: Record<string, unknown>): void {
	if (!notifDebugEnabled()) return;
	// `console.warn` (not `debug`) so the trace shows at the default DevTools log
	// level and is captured by the console interceptors people use for bug
	// reports — `console.debug` is filtered out by both. It's gated behind the
	// off-by-default flag, so this only appears while actively diagnosing.
	if (data) {
		console.warn(`[mc:notif] ${event}`, data);
	} else {
		console.warn(`[mc:notif] ${event}`);
	}
}
