import { describe, expect, it } from "vitest";
import {
	buildDashboardBlock,
	DASHBOARD_END,
	DASHBOARD_START,
	withDashboardBlock,
} from "./dashboard";

describe("buildDashboardBlock", () => {
	it("is vault-wide (no FROM), gated to meeting notes by event_id/meeting_url", () => {
		const block = buildDashboardBlock();
		expect(block).not.toContain("FROM ");
		expect(block).toContain(
			"WHERE (event_id OR meeting_url) AND date(start) >= now"
		);
		expect(block).toContain(
			"WHERE (event_id OR meeting_url) AND date(start) < now"
		);
		// `start` is coerced with `date()` so a plain-string frontmatter value
		// isn't compared against `now` by cross-type ordering (which would put
		// every meeting in "Upcoming").
		expect(block).not.toContain("AND start >= now");
		expect(block).not.toContain("AND start < now");
		// The same coercion must apply to the sort and the rendered Date column,
		// otherwise a string `start` sorts/formats inconsistently against a date.
		expect(block).toContain(
			'dateformat(date(start), "yyyy-MM-dd HH:mm") AS Date'
		);
		expect(block).toContain("SORT date(start) ASC");
		expect(block).toContain("SORT date(start) DESC");
		expect(block).not.toContain("SORT start ASC");
		expect(block).not.toContain("SORT start DESC");
		expect(block).toContain(
			"TASK WHERE !completed AND (file.frontmatter.event_id OR file.frontmatter.meeting_url)"
		);
		expect(block.startsWith(DASHBOARD_START)).toBe(true);
		expect(block.endsWith(DASHBOARD_END)).toBe(true);
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
