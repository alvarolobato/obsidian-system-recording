import { describe, expect, it } from "vitest";
import {
	ACTIONS_BLOCK_LANG,
	buildDashboardBlock,
	DASHBOARD_END,
	DASHBOARD_START,
	PAST_BLOCK_LANG,
	UPCOMING_BLOCK_LANG,
	withDashboardBlock,
} from "./dashboard";

describe("buildDashboardBlock", () => {
	it("has the section headings and starts/ends with the managed markers", () => {
		const block = buildDashboardBlock();
		expect(block).toContain("## Upcoming meetings");
		expect(block).toContain("## Past meetings");
		expect(block).toContain("## Open action items");
		expect(block).toContain("## Needs attention");
		expect(block.startsWith(DASHBOARD_START)).toBe(true);
		expect(block.endsWith(DASHBOARD_END)).toBe(true);
	});

	it("renders every section via plugin blocks, not Dataview", () => {
		const block = buildDashboardBlock();
		expect(block).toContain("```" + UPCOMING_BLOCK_LANG);
		expect(block).toContain("```" + PAST_BLOCK_LANG);
		expect(block).toContain("```" + ACTIONS_BLOCK_LANG);
		// No Dataview left: no FROM/TASK query, no date-split predicates/sorts.
		expect(block).not.toContain("```dataview");
		expect(block).not.toContain("TASK WHERE");
		expect(block).not.toContain("date(start) >= date(now)");
		expect(block).not.toContain("date(start) < date(now)");
		expect(block).not.toContain("SORT date(start) ASC");
		expect(block).not.toContain("SORT date(start) DESC");
	});
});

describe("withDashboardBlock", () => {
	it("appends the block when absent", () => {
		const out = withDashboardBlock("# Dashboard", buildDashboardBlock());
		expect(out).toContain("# Dashboard");
		expect(out).toContain(DASHBOARD_START);
	});

	it("replaces an existing managed block, leaving surrounding text", () => {
		const first = withDashboardBlock(
			"# Dashboard\n\nintro\n",
			buildDashboardBlock()
		);
		const second = withDashboardBlock(first, buildDashboardBlock());
		expect(second).toContain("intro");
		// Only one managed block remains.
		expect(second.split(DASHBOARD_START).length - 1).toBe(1);
	});
});
