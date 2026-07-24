import { describe, it, expect } from "vitest";
import { cleanSuggestedTitle, shouldSuggestAdhocTitle } from "./adhocTitle";

describe("shouldSuggestAdhocTitle", () => {
	it("offers for an ad-hoc id when the setting is on and not yet suggested", () => {
		expect(
			shouldSuggestAdhocTitle({
				suggestAdhocTitle: true,
				eventId: "adhoc-123",
				alreadySuggested: undefined,
			})
		).toBe(true);
	});

	it("skips when the setting is off", () => {
		expect(
			shouldSuggestAdhocTitle({
				suggestAdhocTitle: false,
				eventId: "adhoc-123",
				alreadySuggested: undefined,
			})
		).toBe(false);
	});

	it("skips calendar (non-adhoc) event ids", () => {
		expect(
			shouldSuggestAdhocTitle({
				suggestAdhocTitle: true,
				eventId: "evt-abc",
				alreadySuggested: undefined,
			})
		).toBe(false);
	});

	it("skips when already suggested", () => {
		expect(
			shouldSuggestAdhocTitle({
				suggestAdhocTitle: true,
				eventId: "adhoc-123",
				alreadySuggested: true,
			})
		).toBe(false);
	});

	it("skips missing or non-string event ids", () => {
		expect(
			shouldSuggestAdhocTitle({
				suggestAdhocTitle: true,
				eventId: undefined,
				alreadySuggested: undefined,
			})
		).toBe(false);
		expect(
			shouldSuggestAdhocTitle({
				suggestAdhocTitle: true,
				eventId: 42,
				alreadySuggested: undefined,
			})
		).toBe(false);
	});
});

describe("cleanSuggestedTitle", () => {
	it("strips quotes and trailing punctuation", () => {
		expect(cleanSuggestedTitle('"Startup Mentality Shift."')).toBe(
			"Startup Mentality Shift"
		);
	});

	it("uses the first non-empty line only", () => {
		expect(cleanSuggestedTitle("\nFoo Bar\nignored")).toBe("Foo Bar");
	});

	it("returns empty-ish sanitized fallback for blank input", () => {
		// sanitizeName maps blank → "Untitled"; callers treat a non-useful
		// title as missing when deciding whether to offer a rename.
		expect(cleanSuggestedTitle("   \n  ")).toBe("Untitled");
	});
});
