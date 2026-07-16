import { beforeAll, describe, expect, it } from "vitest";
import {
	isCapabilityMiss,
	isDiarizationCancelled,
	normalizeEngineProgress,
	shouldInvalidateProbe,
	type DiarizedResult,
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

	it("is false when the no-segment text is nothing but a hallucination (issue #61)", () => {
		// A proxy that drops the segments array on silence must not be read as
		// timestamp-incapable — that would disable speaker separation forever.
		expect(isCapabilityMiss([], "Thanks for watching!")).toBe(false);
		expect(isCapabilityMiss([], "Please Like Subscribe and Enable Notifications")).toBe(false);
	});

	it("is still a miss when real text is mixed with a hallucinated line", () => {
		// Stripping only removes the stock line; the real line proves the
		// endpoint transcribed audio but dropped timestamps => capability miss.
		expect(isCapabilityMiss([], "Thanks for watching!\nhello there")).toBe(true);
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

describe("shouldInvalidateProbe", () => {
	const result = (over: Partial<DiarizedResult>): DiarizedResult => ({
		text: "",
		diarized: false,
		...over,
	});

	it("invalidates only on a genuine capability miss", () => {
		expect(shouldInvalidateProbe(result({ reason: "capability" }))).toBe(true);
	});

	it("keeps the probe on a transient error (issue #61)", () => {
		// A flaky chunk this run must not disable speaker separation forever.
		expect(shouldInvalidateProbe(result({ reason: "error" }))).toBe(false);
	});

	it("keeps the probe on a successful diarized result", () => {
		expect(
			shouldInvalidateProbe({ text: "Me: hi", diarized: true })
		).toBe(false);
	});

	it("keeps the probe when no reason was given", () => {
		expect(shouldInvalidateProbe(result({}))).toBe(false);
	});
});

describe("normalizeEngineProgress", () => {
	it("maps the engine's 10%→90% band onto a full 0→100 bar", () => {
		// The vendored engine starts at ~10% (preparation) and tops out at 90%
		// (it never emits the caller-owned 100).
		expect(normalizeEngineProgress(10)).toBe(0);
		expect(normalizeEngineProgress(50)).toBe(50);
		expect(normalizeEngineProgress(90)).toBe(100);
	});

	it("clamps values outside the band", () => {
		expect(normalizeEngineProgress(0)).toBe(0);
		expect(normalizeEngineProgress(-20)).toBe(0);
		expect(normalizeEngineProgress(120)).toBe(100);
	});

	it("keeps the diarized halves within their 0–50 / 50–100 lanes", () => {
		// The backend's shared job runner slices "me" onto 0–50 and "them" onto
		// 50–100 (see runJobsSequentially); a full engine pass, once normalized,
		// must never cross the midpoint or exceed 100.
		const me = (p: number) => normalizeEngineProgress(p) * 0.5;
		const them = (p: number) => 50 + normalizeEngineProgress(p) * 0.5;
		expect(me(10)).toBe(0);
		expect(me(90)).toBe(50);
		expect(them(10)).toBe(50);
		expect(them(90)).toBe(100);
	});
});
