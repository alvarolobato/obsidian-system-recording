import { describe, expect, it } from "vitest";
import {
	ADHOC_TITLE_PROMPT_SUFFIX,
	DEFAULT_ENRICH_PROMPT,
	effectiveEnrichPrompt,
	extractEmbeddedTitle,
	fillPrompt,
} from "./prompt";

describe("fillPrompt", () => {
	it("substitutes all placeholders", () => {
		const out = fillPrompt(DEFAULT_ENRICH_PROMPT, {
			title: "Sprint sync",
			date: "2026-07-10",
			attendees: "Ann, Bob",
			notes: "we shipped X",
			actionItems: "- Follow up with Bob",
			followUps: "- **Kate:** Send the doc",
			transcript: "Ann: hi",
		});
		expect(out).toContain("Meeting: Sprint sync");
		expect(out).toContain("Date: 2026-07-10");
		expect(out).toContain("Attendees: Ann, Bob");
		expect(out).toContain("we shipped X");
		expect(out).toContain("- Follow up with Bob");
		expect(out).toContain("- **Kate:** Send the doc");
		expect(out).toContain("Ann: hi");
		expect(out).not.toContain("{{");
	});

	it("substitutes the action-items and follow-ups placeholders", () => {
		const out = fillPrompt("{{actionItems}}|{{followUps}}", {
			title: "t",
			date: "d",
			attendees: "",
			notes: "",
			actionItems: "- Ship the release",
			followUps: "- **Bob:** Review PR",
			transcript: "",
		});
		expect(out).toBe("- Ship the release|- **Bob:** Review PR");
	});

	it("defaults empty fields to (none)", () => {
		const out = fillPrompt(
			"{{notes}}|{{actionItems}}|{{followUps}}|{{transcript}}",
			{
				title: "t",
				date: "d",
				attendees: "",
				notes: "",
				actionItems: "",
				followUps: "",
				transcript: "   ",
			}
		);
		expect(out).toBe("(none)|(none)|(none)|(none)");
	});
});

describe("effectiveEnrichPrompt", () => {
	const custom = "My own prompt with {{notes}} and {{transcript}}.";

	it("uses the live default when not customizing", () => {
		expect(effectiveEnrichPrompt(false, "")).toBe(DEFAULT_ENRICH_PROMPT);
		expect(effectiveEnrichPrompt(false, custom)).toBe(DEFAULT_ENRICH_PROMPT);
	});

	it("uses the custom prompt when customizing with non-empty text", () => {
		expect(effectiveEnrichPrompt(true, custom)).toBe(custom);
	});

	it("falls back to the default when customizing but the prompt is blank", () => {
		expect(effectiveEnrichPrompt(true, "")).toBe(DEFAULT_ENRICH_PROMPT);
		expect(effectiveEnrichPrompt(true, "   ")).toBe(DEFAULT_ENRICH_PROMPT);
		expect(effectiveEnrichPrompt(true, null)).toBe(DEFAULT_ENRICH_PROMPT);
		expect(effectiveEnrichPrompt(true, undefined)).toBe(
			DEFAULT_ENRICH_PROMPT
		);
	});

	it("keeps the built-in default introducing actionItems and followUps", () => {
		expect(DEFAULT_ENRICH_PROMPT).toContain("{{actionItems}}");
		expect(DEFAULT_ENRICH_PROMPT).toContain("{{followUps}}");
		expect(DEFAULT_ENRICH_PROMPT).toContain("### Follow-ups");
		expect(DEFAULT_ENRICH_PROMPT).toContain("### Next steps");
	});
});

describe("extractEmbeddedTitle", () => {
	it("pulls the trailer and leaves the notes body", () => {
		const raw = `### TL;DR\n- Shipped X\n\n<!--mc-title: Shipped The Launch-->`;
		expect(extractEmbeddedTitle(raw)).toEqual({
			body: "### TL;DR\n- Shipped X",
			title: "Shipped The Launch",
		});
	});

	it("tolerates spacing variants in the marker", () => {
		const raw = `notes\n<!-- mc-title:  Foo Bar  -->\n`;
		expect(extractEmbeddedTitle(raw)).toEqual({
			body: "notes",
			title: "Foo Bar",
		});
	});

	it("returns a null title when the trailer is missing", () => {
		expect(extractEmbeddedTitle("### TL;DR\n- only notes")).toEqual({
			body: "### TL;DR\n- only notes",
			title: null,
		});
	});

	it("ignores a mid-body marker that is not the trailing line", () => {
		const raw = `<!--mc-title: Wrong-->\n### TL;DR\n- real notes`;
		expect(extractEmbeddedTitle(raw)).toEqual({
			body: raw.trimEnd(),
			title: null,
		});
	});

	it("ignores a marker that is only inline at the end", () => {
		const raw = `### TL;DR\n- real notes <!--mc-title: Wrong-->`;
		expect(extractEmbeddedTitle(raw)).toEqual({
			body: raw.trimEnd(),
			title: null,
		});
	});

	it("the suffix asks for the machine-readable trailer", () => {
		expect(ADHOC_TITLE_PROMPT_SUFFIX).toContain("<!--mc-title:");
	});
});
