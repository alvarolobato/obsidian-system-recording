import { describe, it, expect } from "vitest";
import { decideWindowFocused } from "./windowFocus";

describe("decideWindowFocused", () => {
	describe("with Electron BrowserWindow state (preferred)", () => {
		it("is focused only when frontmost, not minimized, and visible", () => {
			expect(
				decideWindowFocused({
					win: { isFocused: true, isMinimized: false, isVisible: true },
					visibilityState: "hidden", // ignored when win is present
					hasFocus: false,
				})
			).toBe(true);
		});

		it("is not focused when the window is minimized (even if isFocused reads true)", () => {
			expect(
				decideWindowFocused({
					win: { isFocused: true, isMinimized: true, isVisible: true },
					visibilityState: "visible",
					hasFocus: true,
				})
			).toBe(false);
		});

		it("is not focused when the window isn't visible", () => {
			expect(
				decideWindowFocused({
					win: { isFocused: true, isMinimized: false, isVisible: false },
					visibilityState: "visible",
					hasFocus: true,
				})
			).toBe(false);
		});

		it("is not focused when the window isn't frontmost", () => {
			expect(
				decideWindowFocused({
					win: { isFocused: false, isMinimized: false, isVisible: true },
					visibilityState: "visible",
					hasFocus: true,
				})
			).toBe(false);
		});
	});

	describe("DOM fallback (electron.remote unreachable → win is null)", () => {
		it("is focused when the document is visible and has focus", () => {
			expect(
				decideWindowFocused({
					win: null,
					visibilityState: "visible",
					hasFocus: true,
				})
			).toBe(true);
		});

		it("is not focused when the document is hidden", () => {
			expect(
				decideWindowFocused({
					win: null,
					visibilityState: "hidden",
					hasFocus: true,
				})
			).toBe(false);
		});

		it("is not focused when the document lacks focus", () => {
			expect(
				decideWindowFocused({
					win: null,
					visibilityState: "visible",
					hasFocus: false,
				})
			).toBe(false);
		});

		it("is not focused when there's no document (visibilityState 'n/a')", () => {
			expect(
				decideWindowFocused({
					win: null,
					visibilityState: "n/a",
					hasFocus: false,
				})
			).toBe(false);
		});
	});
});
