import { describe, it, expect } from "vitest";
import { extractMeetingUrlFromText } from "./meetingUrl";

describe("extractMeetingUrlFromText", () => {
	it("finds a Zoom join link in free text", () => {
		const text = "Dial in or join https://acme.zoom.us/j/123456789?pwd=abc see you";
		expect(extractMeetingUrlFromText(text)).toBe(
			"https://acme.zoom.us/j/123456789?pwd=abc"
		);
	});

	it("finds a Google Meet link", () => {
		expect(
			extractMeetingUrlFromText("Meet: https://meet.google.com/abc-defg-hij")
		).toBe("https://meet.google.com/abc-defg-hij");
	});

	it("finds a Teams meetup-join link", () => {
		const url =
			"https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc/0?context=x";
		expect(extractMeetingUrlFromText(`Join here ${url}`)).toBe(url);
	});

	it("scans multiple fields in order", () => {
		expect(
			extractMeetingUrlFromText(
				"Conference Room B",
				"Notes: https://meet.google.com/xyz-mnop-qrs"
			)
		).toBe("https://meet.google.com/xyz-mnop-qrs");
	});

	it("returns null when no known provider link is present", () => {
		expect(
			extractMeetingUrlFromText("See the agenda at https://example.com/agenda")
		).toBeNull();
		expect(extractMeetingUrlFromText(null, undefined, "")).toBeNull();
	});
});
