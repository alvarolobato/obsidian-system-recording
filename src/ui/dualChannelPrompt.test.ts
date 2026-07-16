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
	make: () => OsHandle;
	posts: () => number;
	closes: () => number;
} {
	let posts = 0;
	let closes = 0;
	return {
		make: (): OsHandle => {
			posts++;
			return {
				close: (): void => {
					closes++;
				},
			};
		},
		posts: () => posts,
		closes: () => closes,
	};
}

describe("startDualChannelPrompt", () => {
	it("always shows the in-app notice", () => {
		const inApp = trackedInApp();
		const os = trackedOs();
		startDualChannelPrompt({
			focused: true,
			showInApp: inApp.make,
			showOs: os.make,
		});
		expect(inApp.shows()).toBe(1);
	});

	it("skips the OS notification when Obsidian is frontmost", () => {
		const inApp = trackedInApp();
		const os = trackedOs();
		startDualChannelPrompt({
			focused: true,
			showInApp: inApp.make,
			showOs: os.make,
		});
		expect(os.posts()).toBe(0);
	});

	it("adds the OS notification when Obsidian isn't frontmost", () => {
		const inApp = trackedInApp();
		const os = trackedOs();
		startDualChannelPrompt({
			focused: false,
			showInApp: inApp.make,
			showOs: os.make,
		});
		expect(inApp.shows()).toBe(1);
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
		ctrl.dispose();
		expect(inApp.hides()).toBe(1);
		expect(os.closes()).toBe(1);
	});

	it("dispose with keepOs hides the in-app notice but leaves the OS notification", () => {
		const inApp = trackedInApp();
		const os = trackedOs();
		const ctrl = startDualChannelPrompt({
			focused: false,
			showInApp: inApp.make,
			showOs: os.make,
		});
		ctrl.dispose({ keepOs: true });
		expect(inApp.hides()).toBe(1);
		expect(os.closes()).toBe(0);
	});

	it("dispose on a focused prompt just hides the in-app notice (no OS to close)", () => {
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
		ctrl.dispose();
		ctrl.dispose(); // no-op
		ctrl.dispose({ keepOs: true }); // no-op
		expect(inApp.hides()).toBe(1);
		expect(os.closes()).toBe(1);
	});
});
