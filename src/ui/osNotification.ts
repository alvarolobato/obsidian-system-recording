/**
 * Native OS notifications (Tier 0). Obsidian's `Notice` is in-app only, so it's
 * invisible when Obsidian is minimized.
 *
 * We prefer Electron's **main-process** `Notification` (reached from the
 * renderer via `electron.remote`), because it's the only path that can render
 * macOS **action buttons** — the first inline, the rest under the notification's
 * dropdown ("Options"). When `remote` isn't exposed (older/newer Obsidian) or a
 * notification can't be shown that way, we fall back to the renderer's **web
 * Notifications API**, which shows a plain banner (title + body, no buttons)
 * whose click still opens the in-app prompt.
 */

/** One action button on a native notification. The first is inline; extras go in the macOS dropdown. */
export interface OsNotificationAction {
	text: string;
	run: () => void;
}

interface RemoteNotificationInstance {
	show(): void;
	close(): void;
	on(
		event: "click" | "action" | "close" | "failed",
		listener: (...args: unknown[]) => void
	): void;
}

interface RemoteNotificationCtor {
	new (opts: {
		title: string;
		body: string;
		actions?: { type: "button"; text: string }[];
		silent?: boolean;
	}): RemoteNotificationInstance;
	isSupported?: () => boolean;
}

interface ElectronRemoteLike {
	Notification?: RemoteNotificationCtor;
}

interface ElectronRendererLike {
	remote?: ElectronRemoteLike;
}

/** Requests notification permission once, so later (web-fallback) notifications can show. */
export function requestNotificationPermission(): void {
	try {
		const N = window.Notification;
		if (N && N.permission === "default") {
			void N.requestPermission();
		}
	} catch {
		// Notifications unavailable (e.g. mobile); silently ignore.
	}
}

/** The last notification we showed (native or web), so a newer one supersedes it instead of stacking. */
let lastNative: RemoteNotificationInstance | null = null;
let lastWeb: Notification | null = null;

function focusObsidian(): void {
	try {
		window.focus();
	} catch {
		// Best-effort; clicking usually foregrounds the app on macOS anyway.
	}
}

/**
 * Resolves the main-process `Notification` constructor via `electron.remote`,
 * or null when it isn't reachable / supported. Kept defensive: any missing seam
 * (no `require`, no `remote`, unsupported platform) just yields the web path.
 */
function getRemoteNotificationCtor(): RemoteNotificationCtor | null {
	try {
		const req = (window as unknown as { require?: (id: string) => unknown })
			.require;
		if (typeof req !== "function") return null;
		const electron = req("electron") as ElectronRendererLike | undefined;
		const Ctor = electron?.remote?.Notification;
		if (!Ctor) return null;
		if (typeof Ctor.isSupported === "function" && !Ctor.isSupported()) {
			return null;
		}
		return Ctor;
	} catch {
		return null;
	}
}

/** Attempts a native notification with action buttons. Returns false to signal a fallback. */
function showNativeWithActions(
	title: string,
	body: string,
	onClick: (() => void) | undefined,
	actions: OsNotificationAction[]
): boolean {
	const Ctor = getRemoteNotificationCtor();
	if (!Ctor) return false;
	try {
		try {
			lastNative?.close();
		} catch {
			// ignore
		}
		const notification = new Ctor({
			title,
			body,
			actions: actions.map((a) => ({ type: "button", text: a.text })),
		});
		lastNative = notification;
		let failed = false;
		notification.on("failed", () => {
			failed = true;
		});
		notification.on("click", () => {
			focusObsidian();
			if (lastNative === notification) lastNative = null;
			onClick?.();
		});
		notification.on("action", (...args: unknown[]) => {
			focusObsidian();
			// Electron passes (event, index); the index maps into `actions`.
			const index = typeof args[1] === "number" ? args[1] : 0;
			if (lastNative === notification) lastNative = null;
			actions[index]?.run();
		});
		notification.on("close", () => {
			if (lastNative === notification) lastNative = null;
		});
		notification.show();
		// `failed` (unsigned app / OS refusal) is emitted synchronously on show
		// for the common cases; if it fired, fall back to the web notification.
		return !failed;
	} catch {
		return false;
	}
}

/** Shows a plain web-API banner (no action buttons); its click opens the in-app prompt. */
function showWebNotification(
	title: string,
	body: string,
	onClick?: () => void
): boolean {
	try {
		const N = window.Notification;
		if (!N || N.permission !== "granted") return false;
		try {
			lastWeb?.close();
		} catch {
			// ignore
		}
		const notification = new N(title, { body });
		lastWeb = notification;
		notification.onclick = (): void => {
			focusObsidian();
			try {
				notification.close();
			} catch {
				// ignore
			}
			if (lastWeb === notification) lastWeb = null;
			onClick?.();
		};
		return true;
	} catch {
		return false;
	}
}

/**
 * Shows a native OS notification. Returns true when one was actually shown, so
 * callers can fall back to an in-app Notice otherwise. `onClick` fires when the
 * user clicks the notification body (we also bring Obsidian to the front).
 *
 * When `actions` are supplied we try Electron's main-process notification so
 * they render as real macOS buttons; if that path is unavailable we degrade to
 * a plain banner (the caller's in-app notice still carries the same actions).
 */
export function notifyOs(
	title: string,
	body: string,
	onClick?: () => void,
	actions?: OsNotificationAction[]
): boolean {
	if (
		actions &&
		actions.length > 0 &&
		showNativeWithActions(title, body, onClick, actions)
	) {
		return true;
	}
	return showWebNotification(title, body, onClick);
}
