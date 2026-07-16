/**
 * Coordinates a meeting prompt across two channels so it's **never silently
 * lost**:
 *
 *  - The in-app Obsidian `Notice` is **always** shown. It's the reliable
 *    channel and it stays in Obsidian until dismissed, so even if the user is
 *    away when it fires, the prompt is waiting when they come back.
 *  - A native OS notification is shown **additionally, only when Obsidian isn't
 *    frontmost** — an in-app notice can't be seen there. When Obsidian is
 *    frontmost the native banner would just duplicate the in-app notice, so it's
 *    skipped.
 *
 * (This deliberately replaced an earlier design that posted the OS notification
 * first and used its `show` event to suppress the in-app notice. That event is
 * an unreliable "was it seen?" signal — macOS fires it even when it routes the
 * notification silently to Notification Center under Focus/DND — which could
 * leave the prompt invisible on every channel.)
 *
 * `dispose()` tears the prompt down. It closes the OS notification by default
 * (supersede / user action), but callers doing housekeeping sweeps can pass
 * `{ keepOs: true }` to leave the OS notification in Notification Center so a
 * missed prompt stays recoverable there.
 */

/** Minimal handle to an in-app notice — Obsidian's `Notice` satisfies this. */
export interface InAppHandle {
	hide(): void;
}

/** Minimal handle to a native OS notification. */
export interface OsHandle {
	close(): void;
}

export interface DualChannelController {
	/**
	 * Tear down: hide the in-app notice and, unless `keepOs` is set, close the OS
	 * notification too. Housekeeping sweeps pass `{ keepOs: true }` so the OS
	 * notification survives in Notification Center.
	 *
	 * One-shot: the first call wins. A `{ keepOs: true }` teardown therefore hands
	 * the OS notification off to Notification Center for good — the caller forgets
	 * this controller, so a later same-key prompt can't reach back to close it
	 * (it posts its own instead). That deliberate stacking is the cost of keeping
	 * a missed prompt recoverable; callers that must replace a prompt (supersede /
	 * user action) use the default `dispose()` to close the OS notification.
	 */
	dispose(opts?: { keepOs?: boolean }): void;
}

export interface DualChannelOptions {
	/** Whether Obsidian's window is frontmost (so the in-app notice is visible). */
	focused: boolean;
	/** Creates and shows the in-app notice, returning a handle to hide it. */
	showInApp: () => InAppHandle;
	/** Posts the native OS notification (called only when unfocused), returning a handle to close it. */
	showOs: () => OsHandle;
}

/**
 * Starts the coordination and returns a controller. See the module doc for the
 * policy: in-app always, native OS additive when unfocused.
 */
export function startDualChannelPrompt(
	opts: DualChannelOptions
): DualChannelController {
	// The in-app notice always goes up — it's reliable and waits in Obsidian.
	let inApp: InAppHandle | null = opts.showInApp();
	// The native OS notification is additive, only when Obsidian isn't frontmost.
	let os: OsHandle | null = opts.focused ? null : opts.showOs();
	let disposed = false;

	return {
		dispose(o?: { keepOs?: boolean }): void {
			if (disposed) return;
			disposed = true;
			if (inApp) {
				inApp.hide();
				inApp = null;
			}
			// keepOs: intentionally leave the OS notification in Notification
			// Center so a missed prompt stays recoverable there.
			if (!o?.keepOs && os) {
				os.close();
				os = null;
			}
		},
	};
}
