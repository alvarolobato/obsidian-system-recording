import { requestUrl } from "obsidian";
import type { GoogleOAuth } from "../auth/googleOAuth";
import { extractMeetLink, RawConferenceEvent } from "./meetLink";

export interface GCalEvent {
	id: string;
	summary: string;
	location: string;
	start: Date;
	end: Date;
	allDay: boolean;
	meetLink: string | null;
	htmlLink: string;
	/** Display names (falling back to email) of human attendees, excluding rooms/resources. */
	attendees: string[];
	organizer: string | null;
	/** Stable identifier shared across every instance of a recurring series. */
	iCalUID: string | null;
	/** Present only on instances of a recurring series; points at the master event. */
	recurringEventId: string | null;
}

export interface GCalCalendar {
	id: string;
	summary: string;
	primary: boolean;
}

const API = "https://www.googleapis.com/calendar/v3";

interface RawAttendee {
	email?: string;
	displayName?: string;
	resource?: boolean;
	self?: boolean;
}

interface RawEvent extends RawConferenceEvent {
	id?: string;
	summary?: string;
	location?: string;
	htmlLink?: string;
	iCalUID?: string;
	recurringEventId?: string;
	organizer?: { email?: string; displayName?: string };
	attendees?: RawAttendee[];
	start?: { date?: string; dateTime?: string };
	end?: { date?: string; dateTime?: string };
}

/** Maps raw attendees to display names, dropping meeting rooms and other resources. */
function mapAttendees(raw: RawAttendee[] | undefined): string[] {
	return (raw ?? [])
		.filter((a) => !a.resource)
		.map((a) => (a.displayName || a.email || "").trim())
		.filter((name) => name.length > 0);
}

async function authedGet(oauth: GoogleOAuth, url: string): Promise<unknown> {
	const token = await oauth.getAccessToken();
	const res = await requestUrl({
		url,
		method: "GET",
		headers: { Authorization: `Bearer ${token}` },
		throw: false,
	});
	if (res.status >= 400) {
		throw new Error(`Google API HTTP ${res.status}: ${res.text}`);
	}
	return res.json;
}

export async function listCalendars(oauth: GoogleOAuth): Promise<GCalCalendar[]> {
	const json = (await authedGet(oauth, `${API}/users/me/calendarList?maxResults=250`)) as {
		items?: Array<{ id?: string; summary?: string; primary?: boolean }>;
	};
	return (json.items ?? []).map((c) => ({
		id: c.id ?? "",
		summary: c.summary ?? "(no name)",
		primary: !!c.primary,
	}));
}

export async function listEvents(
	oauth: GoogleOAuth,
	calendarId: string,
	timeMin: Date,
	timeMax: Date,
	maxResults = 50
): Promise<GCalEvent[]> {
	const params = new URLSearchParams({
		timeMin: timeMin.toISOString(),
		timeMax: timeMax.toISOString(),
		maxResults: String(maxResults),
		singleEvents: "true",
		orderBy: "startTime",
	}).toString();
	const url = `${API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
	const json = (await authedGet(oauth, url)) as { items?: RawEvent[] };
	return (json.items ?? []).map((ev) => {
		const isAllDay = !!ev.start?.date;
		const start = isAllDay
			? new Date((ev.start?.date ?? "") + "T00:00:00")
			: new Date(ev.start?.dateTime ?? "");
		const end = isAllDay
			? new Date((ev.end?.date ?? "") + "T00:00:00")
			: new Date(ev.end?.dateTime ?? "");
		const organizer =
			(ev.organizer?.displayName || ev.organizer?.email || "").trim() || null;
		return {
			id: ev.id ?? "",
			summary: ev.summary ?? "(no title)",
			location: ev.location ?? "",
			start,
			end,
			allDay: isAllDay,
			meetLink: extractMeetLink(ev),
			htmlLink: ev.htmlLink ?? "",
			attendees: mapAttendees(ev.attendees),
			organizer,
			iCalUID: ev.iCalUID ?? null,
			recurringEventId: ev.recurringEventId ?? null,
		};
	});
}
