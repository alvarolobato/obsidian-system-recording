// Portions adapted from obsidian-meetings-plus (0BSD)
// https://github.com/jabaho9523/obsidian-meetings-plus
// See THIRD_PARTY_NOTICES.md.

import { moment } from "obsidian";
import type { MeetingEventInfo } from "./meetingNote";

const VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)(?::([^}]+))?\s*\}\}/g;

/**
 * Renders a `{{placeholder}}` template against a meeting. Supported placeholders:
 * `title`, `date`, `start[:FMT]`, `end[:FMT]`, `duration`, `location`,
 * `meeting_url`, `organizer`, `attendees`, `attendees_list`,
 * `attendees_wikilinks`, `uid`, `event_id`, `event_link`.
 * Unknown placeholders render as an empty string.
 */
export function renderTemplate(template: string, ev: MeetingEventInfo): string {
	return template.replace(VAR_RE, (_m, name: string, fmt?: string) =>
		resolveVariable(name, fmt, ev)
	);
}

function resolveVariable(
	name: string,
	fmt: string | undefined,
	ev: MeetingEventInfo
): string {
	switch (name) {
		case "title":
			return ev.summary;
		case "date":
			return moment(ev.start).format("YYYY-MM-DD");
		case "start":
			return moment(ev.start).format(fmt || "HH:mm");
		case "end":
			return moment(ev.end).format(fmt || "HH:mm");
		case "duration":
			return String(
				Math.max(
					0,
					Math.round((ev.end.getTime() - ev.start.getTime()) / 60000)
				)
			);
		case "location":
			return ev.location;
		case "meeting_url":
			return ev.meetLink ?? "";
		case "organizer":
			return ev.organizer ?? "";
		case "attendees":
			return ev.attendees.join(", ");
		case "attendees_list":
			return ev.attendees.map((a) => `- ${a}`).join("\n");
		case "attendees_wikilinks":
			return ev.attendees.map((a) => `[[${a}]]`).join(", ");
		case "uid":
			return ev.iCalUID ?? "";
		case "event_id":
			return ev.id;
		case "event_link":
			return ev.htmlLink;
		default:
			return "";
	}
}
