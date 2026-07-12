import { describe, it, expect } from "vitest";
import { renderTemplate } from "./template";
import type { MeetingEventInfo } from "./meetingNote";

function ev(overrides: Partial<MeetingEventInfo> = {}): MeetingEventInfo {
	return {
		id: "evt-1",
		summary: "Team Sync",
		start: new Date("2026-07-10T14:00:00"),
		end: new Date("2026-07-10T14:30:00"),
		meetLink: "https://meet.google.com/abc-defg-hij",
		location: "Room B",
		htmlLink: "https://calendar.google.com/event?eid=x",
		attendees: ["Alice", "Bob"],
		organizer: "Alice",
		iCalUID: "uid-123",
		recurringEventId: null,
		oneOnOnePartner: null,
		oneOnOnePartnerEmail: null,
		...overrides,
	};
}

describe("renderTemplate", () => {
	it("substitutes the core placeholders", () => {
		const out = renderTemplate(
			"{{title}} | {{date}} | {{start:HHmm}}-{{end:HHmm}} | {{duration}}min",
			ev()
		);
		expect(out).toBe("Team Sync | 2026-07-10 | 1400-1430 | 30min");
	});

	it("renders attendee variants", () => {
		expect(renderTemplate("{{attendees}}", ev())).toBe("Alice, Bob");
		expect(renderTemplate("{{attendees_list}}", ev())).toBe("- Alice\n- Bob");
		expect(renderTemplate("{{attendees_wikilinks}}", ev())).toBe(
			"[[Alice]], [[Bob]]"
		);
	});

	it("renders empty strings for missing values, not the literal", () => {
		const out = renderTemplate("[{{meeting_url}}][{{organizer}}]", ev({
			meetLink: null,
			organizer: null,
		}));
		expect(out).toBe("[][]");
	});

	it("leaves unknown placeholders empty", () => {
		expect(renderTemplate("x{{nope}}y", ev())).toBe("xy");
	});

	it("renders the folder-template tokens", () => {
		expect(renderTemplate("{{year}}", ev())).toBe("2026");
		expect(renderTemplate("{{month}}", ev())).toBe("07");
		expect(renderTemplate("{{series}}", ev())).toBe("Team Sync");
	});
});
