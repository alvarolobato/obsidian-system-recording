import { describe, it, expect } from "vitest";
import {
	shouldRecord,
	parseKeywords,
	isMeetingEventType,
	matchesExclusionKeyword,
} from "./eventFilter";

describe("shouldRecord", () => {
	it("records a normal timed event when there are no keywords", () => {
		expect(shouldRecord({ summary: "Team sync", allDay: false }, [])).toBe(true);
	});

	it("never records all-day events", () => {
		expect(shouldRecord({ summary: "Holiday", allDay: true }, [])).toBe(false);
	});

	it("excludes when the title contains a keyword (case-insensitive)", () => {
		expect(shouldRecord({ summary: "1on1 with Alice", allDay: false }, ["1ON1"])).toBe(false);
	});

	it("records when no keyword matches the title", () => {
		expect(shouldRecord({ summary: "Design review", allDay: false }, ["lunch", "1on1"])).toBe(true);
	});

	it("ignores blank keywords", () => {
		expect(shouldRecord({ summary: "anything", allDay: false }, ["", "  "])).toBe(true);
	});
});

describe("matchesExclusionKeyword", () => {
	it("matches case-insensitively on substrings", () => {
		expect(matchesExclusionKeyword("Weekly LUNCH", ["lunch"])).toBe(true);
		expect(matchesExclusionKeyword("1on1 with Bob", ["1ON1"])).toBe(true);
	});

	it("does not match when no keyword is present", () => {
		expect(matchesExclusionKeyword("Design review", ["lunch", "1on1"])).toBe(
			false
		);
	});

	it("ignores blank keywords and empty lists", () => {
		expect(matchesExclusionKeyword("anything", ["", "  "])).toBe(false);
		expect(matchesExclusionKeyword("anything", [])).toBe(false);
	});
});

describe("isMeetingEventType", () => {
	it("drops Google working-location, out-of-office and focus-time events", () => {
		expect(isMeetingEventType("workingLocation")).toBe(false);
		expect(isMeetingEventType("outOfOffice")).toBe(false);
		expect(isMeetingEventType("focusTime")).toBe(false);
	});

	it("keeps regular meetings and unknown/undefined types", () => {
		expect(isMeetingEventType("default")).toBe(true);
		expect(isMeetingEventType(undefined)).toBe(true);
		expect(isMeetingEventType("fromGmail")).toBe(true);
	});
});

describe("parseKeywords", () => {
	it("splits on newlines and commas and trims, dropping blanks", () => {
		expect(parseKeywords("lunch, 1on1\n  break \n\n,standup")).toEqual(["lunch", "1on1", "break", "standup"]);
	});

	it("returns an empty array for empty input", () => {
		expect(parseKeywords("")).toEqual([]);
	});
});
