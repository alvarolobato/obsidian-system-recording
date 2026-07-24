import { describe, it, expect } from "vitest";
import {
	startDualChannelPrompt,
	InAppHandle,
	OsHandle,
} from "./dualChannelPrompt";

function trackedInApp(): {
	make: () => InAppHandle;
	shows: () => number;
	hides: () => number;
} {
	let shows = 0;
	let hides = 0;
	return {
		make: (): InAppHandle => {
			shows++;
			return {
				hide: (): void => {
					hides++;
				},
			};
		},
		shows: () => shows,
		hides: () => hides,
	};
}

function trackedOs(): {
	make: (fallbackToInApp: () => void) => OsHandle;
	posts: () => number;
	closes: () => number;
	lastFallback: () => (() => void) | null;
} {
	let posts = 0;
	let closes = 0;
	let lastFallback: (() => void) | null = null;
	return {
		make: (fallbackToInApp: () => void): OsHandle => {
			posts++;
			lastFallback = fallbackToInApp;
			return {
				close: (): void => {
					closes++;
				},
			};
		},
		posts: () => posts,
		closes: () => closes,
		lastFallback: () => lastFallback,
	};
}

describe("startDualChannelPrompt", () => {
	it("shows only the in-app notice when Obsidian is frontmost", () => {
		const inApp = trackedInApp();
		const os = trackedOs();
		startDualChannelPrompt({
			focused: true,
			showInApp: inApp.make,
			showOs: os.make,
		});
		expect(inApp.shows()).toBe(1);
		expect(os.posts()).toBe(0);
	});

	it("shows only the OS notification when Obsidian isn't frontmost", () => {
		const inApp = trackedInApp();
		const os = trackedOs();
		startDualChannelPrompt({
			focused: false,
			showInApp: inApp.make,
			showOs: os.make,
		});
		expect(inApp.shows()).toBe(0);
		expect(os.posts()).toBe(1);
	});

	it("dispose hides the in-app notice and closes the OS notification by default", () => {
		const inApp = trackedInApp();
		const os = trackedOs();
		const ctrl = startDualChannelPrompt({
			focused: false,
			showInApp: inApp.make,
			showOs: os.make,
		});
		ctrl.onBecameFocused();
		ctrl.dispose();
		expect(inApp.hides()).toBe(1);
		expect(os.closes()).toBe(1);
	});

	it("dispose with keepOs leaves the OS notification", () => {
		const inApp = trackedInApp();
		const os = trackedOs();
		const ctrl = startDualChannelPrompt({
			focused: false,
			showInApp: inApp.make,
			showOs: os.make,
		});
		ctrl.dispose({ keepOs: true });
		expect(inApp.hides()).toBe(0);
		expect(os.closes()).toBe(0);
	});

	it("dispose on a focused prompt just hides the in-app notice", () => {
		const inApp = trackedInApp();
		const os = trackedOs();
		const ctrl = startDualChannelPrompt({
			focused: true,
			showInApp: inApp.make,
			showOs: os.make,
		});
		ctrl.dispose();
		expect(inApp.hides()).toBe(1);
		expect(os.closes()).toBe(0);
	});

	it("dispose is idempotent — it tears down at most once", () => {
		const inApp = trackedInApp();
		const os = trackedOs();
		const ctrl = startDualChannelPrompt({
			focused: false,
			showInApp: inApp.make,
			showOs: os.make,
		});
		ctrl.onBecameFocused();
		ctrl.dispose();
		ctrl.dispose();
		ctrl.dispose({ keepOs: true });
		expect(inApp.hides()).toBe(1);
		expect(os.closes()).toBe(1);
	});

	it("onBecameFocused closes OS and shows the in-app notice", () => {
		const inApp = trackedInApp();
		const os = trackedOs();
		const ctrl = startDualChannelPrompt({
			focused: false,
			showInApp: inApp.make,
			showOs: os.make,
		});
		expect(inApp.shows()).toBe(0);
		expect(os.posts()).toBe(1);
		ctrl.onBecameFocused();
		expect(os.closes()).toBe(1);
		expect(inApp.shows()).toBe(1);
	});

	it("onBecameFocused is a no-op when already showing in-app", () => {
		const inApp = trackedInApp();
		const os = trackedOs();
		const ctrl = startDualChannelPrompt({
			focused: true,
			showInApp: inApp.make,
			showOs: os.make,
		});
		ctrl.onBecameFocused();
		expect(inApp.shows()).toBe(1);
		expect(os.posts()).toBe(0);
	});

	it("onBecameFocused is a no-op after dispose", () => {
		const inApp = trackedInApp();
		const os = trackedOs();
		const ctrl = startDualChannelPrompt({
			focused: false,
			showInApp: inApp.make,
			showOs: os.make,
		});
		ctrl.dispose();
		ctrl.onBecameFocused();
		expect(inApp.shows()).toBe(0);
		expect(os.closes()).toBe(1);
	});

	it("OS failure falls back to the in-app notice", () => {
		const inApp = trackedInApp();
		const os = trackedOs();
		startDualChannelPrompt({
			focused: false,
			showInApp: inApp.make,
			showOs: os.make,
		});
		expect(inApp.shows()).toBe(0);
		os.lastFallback()?.();
		expect(os.closes()).toBe(1);
		expect(inApp.shows()).toBe(1);
	});

	it("synchronous OS failure does not keep a live OS handle", () => {
		const inApp = trackedInApp();
		let closes = 0;
		const ctrl = startDualChannelPrompt({
			focused: false,
			showInApp: inApp.make,
			showOs: (fallbackToInApp) => {
				fallbackToInApp(); // sync, before return
				return {
					close: (): void => {
						closes++;
					},
				};
			},
		});
		expect(inApp.shows()).toBe(1);
		// The returned handle was closed immediately after the sync fallback.
		expect(closes).toBe(1);
		ctrl.dispose();
		// dispose must not close again (handle already dropped).
		expect(closes).toBe(1);
		expect(inApp.hides()).toBe(1);
	});
});
