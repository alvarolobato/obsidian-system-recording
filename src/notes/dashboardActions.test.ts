import { describe, expect, it } from "vitest";
import {
	countTasks,
	sortActionNoteGroups,
	type ActionNoteGroup,
} from "./dashboardActions";

function group(over: Partial<ActionNoteGroup>): ActionNoteGroup {
	return {
		path: "Meetings/x.md",
		title: "x",
		date: new Date("2026-07-10T10:00:00"),
		tasks: [{ text: "do it", raw: "- [ ] do it", line: 1 }],
		...over,
	};
}

describe("sortActionNoteGroups", () => {
	it("orders notes newest-first by date", () => {
		const sorted = sortActionNoteGroups([
			group({ path: "a.md", date: new Date("2026-07-01T00:00:00") }),
			group({ path: "b.md", date: new Date("2026-07-10T00:00:00") }),
			group({ path: "c.md", date: new Date("2026-07-05T00:00:00") }),
		]);
		expect(sorted.map((g) => g.path)).toEqual(["b.md", "c.md", "a.md"]);
	});

	it("puts dateless notes last, tie-breaking on path", () => {
		const sorted = sortActionNoteGroups([
			group({ path: "z.md", date: null }),
			group({ path: "a.md", date: null }),
			group({ path: "dated.md", date: new Date("2026-07-01T00:00:00") }),
		]);
		expect(sorted.map((g) => g.path)).toEqual([
			"dated.md",
			"a.md",
			"z.md",
		]);
	});

	it("drops groups with no tasks", () => {
		const sorted = sortActionNoteGroups([
			group({ path: "empty.md", tasks: [] }),
			group({ path: "has.md" }),
		]);
		expect(sorted.map((g) => g.path)).toEqual(["has.md"]);
	});
});

describe("countTasks", () => {
	it("sums tasks across groups", () => {
		expect(
			countTasks([
				group({
					tasks: [
						{ text: "a", raw: "- [ ] a", line: 1 },
						{ text: "b", raw: "- [ ] b", line: 2 },
					],
				}),
				group({ tasks: [{ text: "c", raw: "- [ ] c", line: 1 }] }),
			])
		).toBe(3);
	});
});
