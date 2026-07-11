import { requestUrl } from "obsidian";
import type { GoogleOAuth } from "../auth/googleOAuth";
import { extractMeetLink, RawConferenceEvent } from "./meetLink";
import { extractMeetingUrlFromText } from "./meetingUrl";
import { isMeetingEventType, matchesExclusionKeyword } from "./eventFilter";

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
	/** The other attendee's display name (or email) for a 1:1; null for anything else. */
	oneOnOnePartner: string | null;
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
	/** The user's own RSVP: "accepted" | "declined" | "tentative" | "needsAction". */
	responseStatus?: string;
}

/**
 * True when the signed-in user (the `self` attendee) has declined the event.
 * Declined meetings must not auto-open the Meet link or prompt to record.
 * Only an explicit "declined" counts — `needsAction`/`tentative` are kept so
 * unanswered invites still surface.
 */
export function isDeclinedByUser(attendees: RawAttendee[] | undefined): boolean {
	return (attendees ?? []).some(
		(a) => a.self === true && a.responseStatus === "declined"
	);
}

/**
 * Accumulates every page of a Google list endpoint by following `nextPageToken`.
 * `maxPages` bounds the loop so a malformed/looping token can't hang the fetch
 * (Google caps pages at 2500 items, so a few requests cover any realistic day).
 */
export async function collectPages<T>(
	fetchPage: (
		pageToken: string | undefined
	) => Promise<{ items?: T[]; nextPageToken?: string }>,
	maxPages = 20
): Promise<T[]> {
	const all: T[] = [];
	let pageToken: string | undefined;
	for (let page = 0; page < maxPages; page++) {
		const json = await fetchPage(pageToken);
		if (json.items) all.push(...json.items);
		pageToken = json.nextPageToken || undefined;
		if (!pageToken) return all;
	}
	// Bailed at the cap with more pages available. With ascending order this
	// drops the newest items, so warn rather than silently truncate.
	console.warn(
		`[Meeting Copilot] calendar pagination hit ${maxPages}-page cap; some events may be omitted.`
	);
	return all;
}

interface RawEvent extends RawConferenceEvent {
	id?: string;
	summary?: string;
	status?: string;
	eventType?: string;
	location?: string;
	description?: string;
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

/**
 * The other participant's display name (or email) for a 1:1: exactly two
 * non-resource attendees with exactly one of them marked `self`. Null for
 * group meetings, a missing self flag, or an unnamed/emailless partner.
 */
export function oneOnOnePartner(raw: RawAttendee[] | undefined): string | null {
	const humans = (raw ?? []).filter((a) => !a.resource);
	if (humans.length !== 2) return null;
	const selves = humans.filter((a) => a.self === true);
	if (selves.length !== 1) return null;
	const other = humans.find((a) => a.self !== true);
	const name = (other?.displayName || other?.email || "").trim();
	return name.length > 0 ? name : null;
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
	type RawCalendar = { id?: string; summary?: string; primary?: boolean };
	const items = await collectPages<RawCalendar>(async (pageToken) => {
		const params = new URLSearchParams({ maxResults: "250" });
		if (pageToken) params.set("pageToken", pageToken);
		return (await authedGet(
			oauth,
			`${API}/users/me/calendarList?${params.toString()}`
		)) as { items?: RawCalendar[]; nextPageToken?: string };
	});
	return items.map((c) => ({
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
	maxResults = 50,
	exclusionKeywords: string[] = []
): Promise<GCalEvent[]> {
	// Follow nextPageToken so busy calendars (>maxResults events in the window)
	// don't silently drop today's/future meetings — ordered ascending, those are
	// exactly the ones a single truncated page would omit.
	const rawEvents = await collectPages<RawEvent>(async (pageToken) => {
		const params = new URLSearchParams({
			timeMin: timeMin.toISOString(),
			timeMax: timeMax.toISOString(),
			maxResults: String(maxResults),
			singleEvents: "true",
			orderBy: "startTime",
		});
		if (pageToken) params.set("pageToken", pageToken);
		const url = `${API}/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`;
		return (await authedGet(oauth, url)) as {
			items?: RawEvent[];
			nextPageToken?: string;
		};
	});
	return rawEvents
		.filter((ev) => ev.status !== "cancelled") // drop cancelled meetings
		.filter((ev) => !isDeclinedByUser(ev.attendees)) // drop meetings the user declined
		.filter((ev) => isMeetingEventType(ev.eventType))
		.filter((ev) => !ev.start?.date) // drop all-day events (date-only start)
		.filter((ev) => !matchesExclusionKeyword(ev.summary ?? "", exclusionKeywords))
		.map((ev) => {
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
			meetLink:
				extractMeetLink(ev) ??
				extractMeetingUrlFromText(ev.location, ev.description),
			htmlLink: ev.htmlLink ?? "",
			attendees: mapAttendees(ev.attendees),
			organizer,
			iCalUID: ev.iCalUID ?? null,
			recurringEventId: ev.recurringEventId ?? null,
			oneOnOnePartner: oneOnOnePartner(ev.attendees),
		};
	});
}
