import { describe, expect, it } from "vitest";
import { computeAttention, type AttentionInput } from "./attention";

const NOW = new Date("2026-07-11T12:00:00");

function input(over: Partial<AttentionInput>): AttentionInput {
	return {
		path: "Meetings/x.md",
		title: "x",
		start: new Date("2026-07-10T10:00:00"),
		status: "scheduled",
		hasRecording: false,
		...over,
	};
}

describe("computeAttention", () => {
	it("flags a past meeting with no recording as missing everything", () => {
		const rows = computeAttention([input({})], NOW);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.missing).toEqual(["recording", "summary"]);
	});

	it("flags a recorded-but-not-transcribed meeting", () => {
		const rows = computeAttention(
			[input({ status: "recorded", hasRecording: true })],
			NOW
		);
		expect(rows[0]?.missing).toEqual(["transcript", "summary"]);
	});

	it("flags a transcribed-but-not-enriched meeting as missing only the summary", () => {
		const rows = computeAttention(
			[input({ status: "transcribed", hasRecording: true })],
			NOW
		);
		expect(rows[0]?.missing).toEqual(["summary"]);
	});

	it("does not surface a fully enriched meeting", () => {
		const rows = computeAttention(
			[input({ status: "enriched", hasRecording: true })],
			NOW
		);
		expect(rows).toHaveLength(0);
	});

	it("skips clean future meetings but keeps future ones already recorded", () => {
		const future = new Date("2026-07-20T10:00:00");
		expect(
			computeAttention([input({ start: future })], NOW)
		).toHaveLength(0);
		expect(
			computeAttention(
				[input({ start: future, status: "recorded", hasRecording: true })],
				NOW
			)
		).toHaveLength(1);
	});

	it("flags invalid dates and sorts them first", () => {
		const rows = computeAttention(
			[
				input({ path: "a", start: new Date("2026-07-01T10:00:00") }),
				input({ path: "b", start: null }),
			],
			NOW
		);
		expect(rows[0]?.path).toBe("b");
		expect(rows[0]?.missing).toContain("date");
	});
});
