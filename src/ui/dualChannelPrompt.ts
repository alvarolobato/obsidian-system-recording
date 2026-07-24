/**
 * Coordinates a meeting prompt across **exclusive** channels so surfaces never
 * stack:
 *
 *  - **Focused** → in-app Obsidian `Notice` only (no OS banner).
 *  - **Unfocused** → native OS notification only (no in-app Notice yet).
 *  - **Becomes focused** → close the OS handle and show the in-app Notice so
 *    the prompt is waiting with its full action set.
 *  - **OS failed** → fall back to the in-app Notice immediately so the prompt
 *    isn't lost when the system notification can't be shown.
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
	/**
	 * Obsidian became frontmost: close any OS notification and ensure the in-app
	 * Notice is showing. No-op if already disposed or the in-app notice is up.
	 */
	onBecameFocused(): void;
}

export interface DualChannelOptions {
	/** Whether Obsidian's window is frontmost (so the in-app notice is visible). */
	focused: boolean;
	/** Creates and shows the in-app notice, returning a handle to hide it. */
	showInApp: () => InAppHandle;
	/**
	 * Posts the native OS notification (called only when unfocused). Receives a
	 * `fallbackToInApp` callback to invoke if the OS notification can't be shown.
	 */
	showOs: (fallbackToInApp: () => void) => OsHandle;
}

/**
 * Starts the coordination and returns a controller. See the module doc for the
 * policy: exclusive channels, with a focus swap from OS → in-app.
 */
export function startDualChannelPrompt(
	opts: DualChannelOptions
): DualChannelController {
	let inApp: InAppHandle | null = null;
	let os: OsHandle | null = null;
	let disposed = false;
	let fellBackToInApp = false;

	const ensureInApp = (): void => {
		if (disposed || inApp) return;
		inApp = opts.showInApp();
	};

	if (opts.focused) {
		inApp = opts.showInApp();
	} else {
		const pendingOs = opts.showOs(() => {
			// OS couldn't show — don't leave the prompt invisible.
			fellBackToInApp = true;
			if (os) {
				os.close();
				os = null;
			}
			ensureInApp();
		});
		if (fellBackToInApp) {
			pendingOs.close();
		} else {
			os = pendingOs;
		}
	}

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
		onBecameFocused(): void {
			if (disposed) return;
			if (os) {
				os.close();
				os = null;
			}
			ensureInApp();
		},
	};
}
