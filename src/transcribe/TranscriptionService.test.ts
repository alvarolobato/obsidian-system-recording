import { beforeAll, describe, expect, it } from "vitest";
import {
	isCapabilityMiss,
	isDiarizationCancelled,
} from "./TranscriptionService";
import { initializeTranslations, t } from "./vendor/i18n/index";
import en from "./vendor/i18n/translations/en";
import ja from "./vendor/i18n/translations/ja";
import ko from "./vendor/i18n/translations/ko";
import zh from "./vendor/i18n/translations/zh";

// These pure helpers carry the two seams that used to be tangled inside
// transcribeDiarized: telling a capability miss apart from a silent stream, and
// telling a user cancellation apart from a recoverable pass failure. Exercising
// them here avoids standing up the whole vendored controller (App, TFile, the
// audio pipeline) just to reach the branch we care about.

beforeAll(() => {
	// Load translations so t() resolves the real cancelled-by-user message. The
	// default locale is already "en", so we skip initializeI18n (it reaches for
	// Obsidian's getLanguage, which the test mock doesn't provide).
	initializeTranslations({ en, ja, ko, zh });
});

describe("isCapabilityMiss", () => {
	it("is true when there are no segments but non-blank text", () => {
		// Endpoint transcribed the audio yet returned no timestamps.
		expect(isCapabilityMiss([], "hello there")).toBe(true);
	});

	it("is false for a legitimately silent stream (no segments, blank text)", () => {
		expect(isCapabilityMiss([], "")).toBe(false);
		expect(isCapabilityMiss([], "   ")).toBe(false);
	});

	it("is false once the pass produced any segment", () => {
		expect(isCapabilityMiss([{ text: "hi", start: 0, end: 1 }], "hi")).toBe(false);
	});
});

describe("isDiarizationCancelled", () => {
	it("is true when the signal is already aborted", () => {
		const controller = new AbortController();
		controller.abort();
		expect(isDiarizationCancelled(new Error("anything"), controller.signal)).toBe(true);
	});

	it("is true for a DOMException AbortError", () => {
		expect(isDiarizationCancelled(new DOMException("stopped", "AbortError"))).toBe(true);
	});

	it("is true for the vendored cancelled-by-user message", () => {
		const message = t("errors.transcriptionCancelledByUser");
		expect(isDiarizationCancelled(new Error(message))).toBe(true);
	});

	it("is false for an ordinary failure with a live signal", () => {
		const controller = new AbortController();
		expect(isDiarizationCancelled(new Error("partial result"), controller.signal)).toBe(false);
		expect(isDiarizationCancelled(new Error("network blip"))).toBe(false);
	});
});
