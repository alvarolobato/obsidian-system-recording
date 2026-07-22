import { describe, it, expect } from "vitest";

import { findByPathCaseInsensitive } from "./caseInsensitivePath";

const f = (path: string): { path: string } => ({ path });

describe("findByPathCaseInsensitive", () => {
	it("returns an exact (case-sensitive) match", () => {
		const items = [f("Meetings/a.m4a"), f("Other/b.m4a")];
		expect(findByPathCaseInsensitive(items, "Meetings/a.m4a")).toBe(items[0]);
	});

	it("matches ignoring case when the exact case is absent (the bug)", () => {
		// Index registered the folder lowercase; settings-derived path is capital.
		const items = [f("meetings/1-1s/Luca/Recordings/take.m4a")];
		expect(
			findByPathCaseInsensitive(
				items,
				"Meetings/1-1s/Luca/Recordings/take.m4a"
			)
		).toBe(items[0]);
	});

	it("prefers the exact match over a case-only look-alike", () => {
		const lower = f("meetings/a.m4a");
		const exact = f("Meetings/a.m4a");
		// Order the look-alike first so a naive scan would return it.
		expect(findByPathCaseInsensitive([lower, exact], "Meetings/a.m4a")).toBe(
			exact
		);
	});

	it("returns the first case-insensitive match deterministically", () => {
		const first = f("meetings/a.m4a");
		const second = f("MEETINGS/a.m4a");
		expect(findByPathCaseInsensitive([first, second], "Meetings/a.m4a")).toBe(
			first
		);
	});

	it("returns null when nothing matches", () => {
		expect(findByPathCaseInsensitive([f("x/y.m4a")], "a/b.m4a")).toBeNull();
	});

	it("handles an empty list", () => {
		expect(findByPathCaseInsensitive([], "a/b.m4a")).toBeNull();
	});
});
