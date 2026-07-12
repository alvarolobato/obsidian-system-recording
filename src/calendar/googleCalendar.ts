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
	/** The other attendee's email for a 1:1 (lowercased/trimmed); null when unavailable. */
	oneOnOnePartnerEmail: string | null;
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
	organizer?: { email?: string; displayName?: string; self?: boolean };
	attendees?: RawAttendee[];
	/** True when Google truncated the attendee list (large events). */
	attendeesOmitted?: boolean;
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

/** How a raw event's 1:1 shape is judged, beyond the attendee list itself. */
export interface OneOnOneContext {
	/** True when the signed-in user organized the event (`organizer.self`). */
	organizerIsSelf?: boolean;
	/** True when Google truncated the attendee list; nothing can be inferred then. */
	attendeesOmitted?: boolean;
}

/**
 * The other attendee in a 1:1: exactly two non-resource attendees with
 * exactly one of them marked `self`; or, for an event the user organized
 * themselves (`organizerIsSelf`), exactly one non-resource attendee that
 * isn't marked `self` — Google omits the organizer's own attendee entry on
 * some self-organized events. Null for group meetings, a truncated attendee
 * list (`attendeesOmitted`), a missing self flag on two attendees, a single
 * attendee on someone else's event (foreign calendars never mark `self`, so
 * a lone guest proves nothing), or a single attendee who *is* self. Shared by
 * `oneOnOnePartner` and `oneOnOnePartnerEmail` so both agree on what counts
 * as a 1:1.
 */
function oneOnOneOther(
	raw: RawAttendee[] | undefined,
	ctx: OneOnOneContext = {}
): RawAttendee | null {
	if (ctx.attendeesOmitted) return null;
	const humans = (raw ?? []).filter((a) => !a.resource);
	if (humans.length === 1) {
		if (!ctx.organizerIsSelf) return null;
		return humans[0]?.self === true ? null : (humans[0] ?? null);
	}
	if (humans.length !== 2) return null;
	const selves = humans.filter((a) => a.self === true);
	if (selves.length !== 1) return null;
	return humans.find((a) => a.self !== true) ?? null;
}

/**
 * Turns an email address into a human-friendly name for folder/label use, e.g.
 * "sophie.smith@acme.com" → "Sophie Smith". Only a fallback for attendees that
 * carry no display name — we never want a raw address as a 1:1 folder name.
 */
export function humanizeEmailName(email: string): string {
	const local = (email.split("@")[0] ?? "").trim();
	const words = local
		.split(/[._+-]+/)
		.map((w) => w.trim())
		.filter((w) => w.length > 0)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1));
	return words.join(" ") || email.trim();
}

/**
 * The other participant's full name for a 1:1, used to name their folder. Uses
 * the invite's display name when present; otherwise humanizes the email local
 * part (never the raw address). Null for group meetings, a missing self flag,
 * or an unnamed/emailless partner.
 */
export function oneOnOnePartner(
	raw: RawAttendee[] | undefined,
	ctx: OneOnOneContext = {}
): string | null {
	const other = oneOnOneOther(raw, ctx);
	if (!other) return null;
	const display = (other.displayName ?? "").trim();
	if (display.length > 0) return display;
	const email = (other.email ?? "").trim();
	return email.length > 0 ? humanizeEmailName(email) : null;
}

/**
 * The other participant's email for a 1:1 (lowercased/trimmed), keyed on
 * email rather than the mutable display label so the same person renaming
 * themselves between events doesn't fork their notes into two folders. Null
 * for group meetings, a missing self flag, or an emailless partner.
 */
export function oneOnOnePartnerEmail(
	raw: RawAttendee[] | undefined,
	ctx: OneOnOneContext = {}
): string | null {
	const other = oneOnOneOther(raw, ctx);
	const email = (other?.email ?? "").trim().toLowerCase();
	return email.length > 0 ? email : null;
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
			oneOnOnePartner: oneOnOnePartner(ev.attendees, {
				organizerIsSelf: ev.organizer?.self === true,
				attendeesOmitted: ev.attendeesOmitted === true,
			}),
			oneOnOnePartnerEmail: oneOnOnePartnerEmail(ev.attendees, {
				organizerIsSelf: ev.organizer?.self === true,
				attendeesOmitted: ev.attendeesOmitted === true,
			}),
		};
	});
}
