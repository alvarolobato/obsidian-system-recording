/**
 * Native OS notifications (Tier 0). Obsidian's `Notice` is in-app only, so it's
 * invisible when Obsidian is minimized or on another Space.
 *
 * We prefer Electron's **main-process** `Notification` (reached from the
 * renderer via `electron.remote`), because it's the only path that can render a
 * macOS **action button**. macOS/Electron shows a *single* action as a named
 * inline button (in the *Alerts* notification style) but collapses two-or-more
 * into a generic "Options ▾" dropdown, so callers that want the named default
 * button pass just the primary action.
 * When `remote` isn't exposed (older/newer Obsidian) or a notification can't be
 * shown that way, we fall back to the renderer's **web Notifications API**,
 * which shows a plain banner (title + body, no buttons) whose click still opens
 * the in-app prompt.
 *
 * Both paths report back through {@link NotifyOsOptions.onShown} /
 * {@link NotifyOsOptions.onFailed} (native `show` / web `onshow`, or an
 * unrecoverable failure). These are best-effort signals — macOS can fire `show`
 * even when it routes a notification silently to Notification Center — so a
 * caller must not treat `onShown` as proof the user saw a banner. Each
 * {@link notifyOs} call is independent: it never supersedes a previous
 * notification, so coexisting prompts can't close one another.
 */

import { notifLog } from "../util/notifLog";

/** One action button on a native notification. The first is the default; extras go in the macOS dropdown. */
export interface OsNotificationAction {
	text: string;
	run: () => void;
}

export interface NotifyOsOptions {
	title: string;
	/** Native notification body — kept clean (no "click for options" hint). */
	body: string;
	/**
	 * Appended to the body **only** on the web-API fallback, which can't render
	 * action buttons — so it nudges the user to open Obsidian to choose. The
	 * native (button-capable) path ignores it.
	 */
	webHint?: string;
	/** Fires when the notification body is clicked (we also bring Obsidian forward). */
	onClick?: () => void;
	/** Native action buttons (first = default; the rest live under the dropdown). */
	actions?: OsNotificationAction[];
	/**
	 * Fired **at most once** when a system notification was delivered (native
	 * `show`, or web `onshow`). Best-effort — delivery isn't proof it appeared as
	 * a banner (macOS may route it to Notification Center) — so use it for
	 * signals like a one-time hint, not to suppress the in-app notice.
	 */
	onShown?: () => void;
	/** Fired **at most once** when no system notification could be shown at all. */
	onFailed?: () => void;
}

/** Handle to the shown notification, so a caller can close it programmatically. */
export interface OsNotificationHandle {
	close(): void;
}

interface RemoteNotificationInstance {
	show(): void;
	close(): void;
	on(
		event: "click" | "action" | "close" | "failed" | "show",
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
		if (typeof req !== "function") {
			notifLog("getRemoteNotificationCtor: no window.require (web path only)");
			return null;
		}
		const electron = req("electron") as ElectronRendererLike | undefined;
		const Ctor = electron?.remote?.Notification;
		if (!Ctor) {
			notifLog("getRemoteNotificationCtor: electron.remote.Notification missing");
			return null;
		}
		if (typeof Ctor.isSupported === "function" && !Ctor.isSupported()) {
			notifLog("getRemoteNotificationCtor: Notification.isSupported() === false");
			return null;
		}
		notifLog("getRemoteNotificationCtor: native ctor available");
		return Ctor;
	} catch (err) {
		notifLog("getRemoteNotificationCtor: threw", { err: String(err) });
		return null;
	}
}

interface Settler {
	shown: () => void;
	failed: () => void;
	isSettled: () => boolean;
}

/** Ensures `onShown`/`onFailed` each resolve the notification's fate exactly once. */
function makeSettler(opts: NotifyOsOptions): Settler {
	let settled = false;
	return {
		shown: () => {
			if (settled) return;
			settled = true;
			opts.onShown?.();
		},
		failed: () => {
			if (settled) return;
			settled = true;
			opts.onFailed?.();
		},
		isSettled: () => settled,
	};
}

/** Shows a plain web-API banner (no action buttons); its click opens the in-app prompt. */
function createWeb(opts: NotifyOsOptions, settle: Settler): Notification | null {
	try {
		const N = window.Notification;
		notifLog("createWeb: attempting", {
			hasN: !!N,
			permission: N ? N.permission : "n/a",
		});
		if (!N || N.permission !== "granted") {
			notifLog("createWeb: no permission -> failed");
			settle.failed();
			return null;
		}
		const body = opts.webHint ? `${opts.body} · ${opts.webHint}` : opts.body;
		const notification = new N(opts.title, { body });
		notifLog("createWeb: created web notification");
		// `onshow` is the "sure it's on screen" signal for the web path.
		notification.onshow = (): void => {
			notifLog("createWeb: onshow");
			settle.shown();
		};
		notification.onerror = (): void => {
			notifLog("createWeb: onerror");
			settle.failed();
		};
		notification.onclick = (): void => {
			focusObsidian();
			try {
				notification.close();
			} catch {
				// ignore
			}
			opts.onClick?.();
		};
		return notification;
	} catch {
		settle.failed();
		return null;
	}
}

/**
 * Attempts a native notification with action buttons. Returns the instance, or
 * null to signal the caller should fall back to the web path. On an async
 * `failed` (unsigned app / OS refusal) it falls back to the web path itself via
 * `onFallback`, so the settler is still resolved.
 */
function createNative(
	opts: NotifyOsOptions,
	settle: Settler,
	onFallback: () => void
): RemoteNotificationInstance | null {
	const Ctor = getRemoteNotificationCtor();
	if (!Ctor) return null;
	try {
		const actions = opts.actions ?? [];
		const notification = new Ctor({
			title: opts.title,
			body: opts.body,
			actions: actions.map((a) => ({ type: "button", text: a.text })),
		});
		notifLog("createNative: created", {
			title: opts.title,
			actions: actions.length,
		});
		// On the modern UNNotification API (Electron 42+) `show`/`failed` fire
		// asynchronously, so we can't judge success synchronously — listen.
		notification.on("show", () => {
			notifLog("createNative: 'show' event (delivered — may be banner or Notification Center)");
			settle.shown();
		});
		notification.on("failed", (...args: unknown[]) => {
			notifLog("createNative: 'failed' event", { args: args.map(String) });
			// A `show` already won the race (a late/spurious `failed`): don't stack
			// a second, web banner on top of the native one that's on screen.
			if (settle.isSettled()) {
				notifLog("createNative: 'failed' ignored (already settled)");
				return;
			}
			// Native couldn't render (e.g. unsigned build): degrade to a web banner.
			notifLog("createNative: 'failed' -> falling back to web");
			onFallback();
		});
		notification.on("click", () => {
			notifLog("createNative: 'click' event");
			focusObsidian();
			opts.onClick?.();
		});
		notification.on("action", (...args: unknown[]) => {
			notifLog("createNative: 'action' event", { args: args.map(String) });
			focusObsidian();
			// Electron passes (event, index); the index maps into `actions`.
			const index = typeof args[1] === "number" ? args[1] : 0;
			actions[index]?.run();
		});
		notification.on("close", () => {
			notifLog("createNative: 'close' event");
		});
		notification.show();
		notifLog("createNative: show() called");
		return notification;
	} catch (err) {
		notifLog("createNative: threw", { err: String(err) });
		return null;
	}
}

/**
 * Shows a native OS notification, coordinating the native / web fallback and
 * reporting its fate through `onShown` / `onFailed`. `onClick` fires when the
 * user clicks the notification body (we also bring Obsidian to the front).
 *
 * When `actions` are supplied we try Electron's main-process notification so
 * they render as real macOS buttons (default first, rest under the dropdown);
 * if that path is unavailable / fails we degrade to a plain web banner.
 */
export function notifyOs(opts: NotifyOsOptions): OsNotificationHandle {
	notifLog("notifyOs: entry", {
		title: opts.title,
		actions: opts.actions?.length ?? 0,
	});
	const settle = makeSettler(opts);
	let nativeInst: RemoteNotificationInstance | null = null;
	let webInst: Notification | null = null;

	const tryWeb = (): void => {
		webInst = createWeb(opts, settle);
	};

	if (opts.actions && opts.actions.length > 0) {
		nativeInst = createNative(opts, settle, tryWeb);
	}
	if (!nativeInst) {
		notifLog("notifyOs: native unavailable -> trying web");
		tryWeb();
	}
	if (!nativeInst && !webInst) {
		notifLog("notifyOs: neither native nor web could be created -> failed");
		settle.failed();
	}

	return {
		close(): void {
			try {
				nativeInst?.close();
			} catch {
				// ignore
			}
			try {
				webInst?.close();
			} catch {
				// ignore
			}
		},
	};
}
