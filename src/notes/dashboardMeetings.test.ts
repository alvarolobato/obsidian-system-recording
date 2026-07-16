import { describe, expect, it } from "vitest";
import {
	DEFAULT_PAGE_SIZE,
	meetingRows,
	normalizePageSize,
	paginate,
	type DashboardMeetingInput,
} from "./dashboardMeetings";

const NOW = new Date("2026-07-11T12:00:00");

function input(over: Partial<DashboardMeetingInput>): DashboardMeetingInput {
	return {
		key: "k",
		title: "x",
		start: new Date("2026-07-10T10:00:00"),
		status: "enriched",
		hasRecording: false,
		notePath: "Meetings/x.md",
		...over,
	};
}

describe("meetingRows", () => {
	it("keeps past meetings newest-first when direction is past", () => {
		const rows = meetingRows(
			[
				input({ key: "a", start: new Date("2026-07-01T10:00:00") }),
				input({ key: "b", start: new Date("2026-07-10T10:00:00") }),
				input({ key: "c", start: new Date("2026-07-05T10:00:00") }),
			],
			NOW,
			"past"
		);
		expect(rows.map((r) => r.key)).toEqual(["b", "c", "a"]);
	});

	it("keeps upcoming meetings soonest-first when direction is upcoming", () => {
		const rows = meetingRows(
			[
				input({ key: "a", start: new Date("2026-07-20T10:00:00") }),
				input({ key: "b", start: new Date("2026-07-12T10:00:00") }),
				input({ key: "c", start: new Date("2026-07-15T10:00:00") }),
			],
			NOW,
			"upcoming"
		);
		expect(rows.map((r) => r.key)).toEqual(["b", "c", "a"]);
	});

	it("splits on now: past excludes now-or-later, upcoming includes now", () => {
		const items = [
			input({ key: "past", start: new Date("2026-07-10T10:00:00") }),
			input({ key: "now", start: NOW }),
			input({ key: "future", start: new Date("2026-07-12T10:00:00") }),
		];
		expect(meetingRows(items, NOW, "past").map((r) => r.key)).toEqual([
			"past",
		]);
		expect(meetingRows(items, NOW, "upcoming").map((r) => r.key)).toEqual([
			"now",
			"future",
		]);
	});

	it("drops rows with no/invalid start", () => {
		const rows = meetingRows(
			[
				input({ key: "nostart", start: null }),
				input({ key: "bad", start: new Date("nope") }),
				input({ key: "ok" }),
			],
			NOW,
			"past"
		);
		expect(rows.map((r) => r.key)).toEqual(["ok"]);
	});

	it("keeps note-less calendar rows and falls back to an em dash status", () => {
		const rows = meetingRows(
			[input({ status: "", notePath: null })],
			NOW,
			"past"
		);
		expect(rows[0]?.status).toBe("—");
		expect(rows[0]?.notePath).toBeNull();
	});
});

describe("normalizePageSize", () => {
	it("keeps a valid option", () => {
		expect(normalizePageSize(50)).toBe(50);
	});

	it("falls back to the default for invalid / unknown values", () => {
		expect(normalizePageSize(15)).toBe(DEFAULT_PAGE_SIZE);
		expect(normalizePageSize(0)).toBe(DEFAULT_PAGE_SIZE);
		expect(normalizePageSize("50")).toBe(DEFAULT_PAGE_SIZE);
		expect(normalizePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
		expect(normalizePageSize(null)).toBe(DEFAULT_PAGE_SIZE);
	});
});

describe("paginate", () => {
	const rows = Array.from({ length: 25 }, (_, i) => i);

	it("slices the requested page and reports totals", () => {
		const page = paginate(rows, 10, 1);
		expect(page.rows).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(page).toMatchObject({ page: 1, pageCount: 3, total: 25 });
	});

	it("returns the final (partial) page", () => {
		const page = paginate(rows, 10, 3);
		expect(page.rows).toEqual([20, 21, 22, 23, 24]);
		expect(page.page).toBe(3);
	});

	it("clamps an out-of-range page into [1, pageCount]", () => {
		expect(paginate(rows, 10, 99).page).toBe(3);
		expect(paginate(rows, 10, 0).page).toBe(1);
		expect(paginate(rows, 10, -5).page).toBe(1);
	});

	it("normalizes an invalid page size", () => {
		const page = paginate(rows, 999, 1);
		expect(page.rows).toHaveLength(DEFAULT_PAGE_SIZE);
		expect(page.pageCount).toBe(3);
	});

	it("reports one empty page for an empty list", () => {
		const page = paginate<number>([], 10, 1);
		expect(page).toMatchObject({ page: 1, pageCount: 1, total: 0 });
		expect(page.rows).toEqual([]);
	});
});
