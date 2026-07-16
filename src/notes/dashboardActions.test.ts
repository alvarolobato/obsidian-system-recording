import { describe, expect, it } from "vitest";
import {
	cleanTaskText,
	countTasks,
	parseNoteTasks,
	sortActionNoteGroups,
	type ActionNoteGroup,
} from "./dashboardActions";

function group(over: Partial<ActionNoteGroup>): ActionNoteGroup {
	return {
		path: "Meetings/x.md",
		title: "x",
		date: new Date("2026-07-10T10:00:00"),
		tasks: [{ text: "do it", raw: "- [ ] do it", line: 1, done: false }],
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

	it("keeps a group whose only tasks are recently-done (grace period)", () => {
		const sorted = sortActionNoteGroups([
			group({
				path: "done.md",
				tasks: [
					{ text: "d", raw: "- [x] d ✅ 2026-07-10", line: 1, done: true },
				],
			}),
		]);
		expect(sorted.map((g) => g.path)).toEqual(["done.md"]);
	});
});

describe("countTasks", () => {
	it("sums open tasks across groups, excluding done ones", () => {
		expect(
			countTasks([
				group({
					tasks: [
						{ text: "a", raw: "- [ ] a", line: 1, done: false },
						{ text: "b", raw: "- [ ] b", line: 2, done: false },
						{ text: "c", raw: "- [x] c", line: 3, done: true },
					],
				}),
				group({
					tasks: [{ text: "d", raw: "- [ ] d", line: 1, done: false }],
				}),
			])
		).toBe(3);
	});
});

describe("cleanTaskText", () => {
	it("strips the list marker and checkbox", () => {
		expect(cleanTaskText("- [ ] call Sam")).toBe("call Sam");
		expect(cleanTaskText("  * [x] done thing")).toBe("done thing");
	});

	it("strips a trailing completion date", () => {
		expect(cleanTaskText("- [x] ship it ✅ 2026-07-15")).toBe("ship it");
	});

	it("strips a completion date even when a block ref follows it", () => {
		// appendCompletionDate inserts the date *before* a trailing `^id`.
		expect(cleanTaskText("- [x] ship it ✅ 2026-07-15 ^abc123")).toBe(
			"ship it"
		);
	});

	it("strips a trailing block ref on an open task", () => {
		expect(cleanTaskText("- [ ] review PR ^task-1")).toBe("review PR");
	});

	it("keeps inner text intact (links, emphasis)", () => {
		expect(cleanTaskText("- [ ] ping **@Sam** re [[Notes]]")).toBe(
			"ping **@Sam** re [[Notes]]"
		);
	});
});

describe("parseNoteTasks", () => {
	const today = "2026-07-15";

	it("collects open tasks with their line index and raw line", () => {
		const body = ["# Title", "- [ ] first", "text", "- [ ] second"].join(
			"\n"
		);
		const tasks = parseNoteTasks(body, today);
		expect(tasks).toEqual([
			{ line: 1, raw: "- [ ] first", text: "first", done: false },
			{ line: 3, raw: "- [ ] second", text: "second", done: false },
		]);
	});

	it("keeps a done task completed today, drops one completed earlier", () => {
		const body = [
			"- [x] today ✅ 2026-07-15",
			"- [x] yesterday ✅ 2026-07-14",
			"- [x] undated",
		].join("\n");
		const tasks = parseNoteTasks(body, today);
		expect(tasks).toEqual([
			{
				line: 0,
				raw: "- [x] today ✅ 2026-07-15",
				text: "today",
				done: true,
			},
		]);
	});

	it("returns nothing for a note without checkbox tasks", () => {
		expect(parseNoteTasks("# just prose\n- a bullet", today)).toEqual([]);
	});
});
