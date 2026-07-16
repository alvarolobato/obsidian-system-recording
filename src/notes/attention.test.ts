import { describe, expect, it } from "vitest";
import { computeAttention, type AttentionInput } from "./attention";

function input(over: Partial<AttentionInput>): AttentionInput {
	return {
		path: "Meetings/x.md",
		title: "x",
		start: new Date("2026-07-10T10:00:00"),
		status: "recorded",
		hasRecording: true,
		processing: false,
		...over,
	};
}

describe("computeAttention", () => {
	it("skips meetings with no recording (nothing the user can do)", () => {
		// A scheduled meeting, or a past one that was never recorded, has no
		// source to transcribe or summarize, so it never needs attention.
		expect(
			computeAttention([
				input({ status: "scheduled", hasRecording: false }),
				input({
					start: new Date("2026-01-01T10:00:00"),
					status: "scheduled",
					hasRecording: false,
				}),
			])
		).toHaveLength(0);
	});

	it("flags a recorded-but-not-transcribed meeting (transcript only)", () => {
		const rows = computeAttention([input({ status: "recorded" })]);
		expect(rows[0]?.missing).toEqual(["transcript"]);
	});

	it("flags a transcribed-but-not-enriched meeting (summary only)", () => {
		const rows = computeAttention([input({ status: "transcribed" })]);
		expect(rows[0]?.missing).toEqual(["summary"]);
	});

	it("does not surface a fully enriched meeting", () => {
		const rows = computeAttention([input({ status: "enriched" })]);
		expect(rows).toHaveLength(0);
	});

	it("skips a meeting that is currently being processed (transcribing/queued/enriching)", () => {
		expect(
			computeAttention([input({ status: "recorded", processing: true })])
		).toHaveLength(0);
	});

	it("flags invalid dates and sorts them first", () => {
		const rows = computeAttention([
			input({ path: "a", start: new Date("2026-07-01T10:00:00") }),
			input({ path: "b", start: null }),
		]);
		expect(rows[0]?.path).toBe("b");
		expect(rows[0]?.missing).toContain("date");
	});
});
