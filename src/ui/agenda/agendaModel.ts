import { App, TFile } from "obsidian";
import type { GCalEvent } from "../../calendar/googleCalendar";
import {
	recordingLinkTarget,
	scanMeetingNotes,
	type MeetingEventInfo,
	type MeetingNoteScanEntry,
} from "../../notes/meetingNote";

/**
 * A calendar event enriched with the state of its meeting note/recording in the
 * vault. This is the single view-model the agenda sidebar renders.
 */
export interface AgendaMeeting {
	/** Google event id — also the dedup key we store as `event_id` in note frontmatter. */
	id: string;
	title: string;
	start: Date;
	end: Date;
	allDay: boolean;
	meetingUrl: string | null;
	location: string;
	htmlLink: string;
	attendees: string[];
	organizer: string | null;
	iCalUID: string | null;
	recurringEventId: string | null;
	/** The other attendee's display name (or email) for a 1:1; null for anything else. */
	oneOnOnePartner: string | null;
	/** The other attendee's email for a 1:1 (lowercased/trimmed); null when unavailable. */
	oneOnOnePartnerEmail: string | null;
	/** The meeting note, if one has been created. */
	note: TFile | null;
	/** The recording linked from the note, if any. */
	recording: TFile | null;
	/** Free-form status from note frontmatter (scheduled | recorded | transcribed | …). */
	status: string | null;
}

interface NoteIndexEntry {
	file: TFile;
	status: string | null;
	recording: TFile | null;
}

/**
 * Indexes meeting notes by their `event_id` frontmatter (via the shared
 * `scanMeetingNotes` pass) so agenda rows can show note/recording state
 * cheaply, without a second full-vault scan of its own. Pass `entries` to
 * reuse a scan the caller already ran (a render that also builds its own
 * inputs from the same pass) instead of walking the vault again.
 */
export function buildNoteIndex(
	app: App,
	entries: MeetingNoteScanEntry[] = scanMeetingNotes(app)
): Map<string, NoteIndexEntry> {
	const map = new Map<string, NoteIndexEntry>();
	for (const entry of entries) {
		if (!entry.eventId) continue;

		let recording: TFile | null = null;
		const link = recordingLinkTarget(entry.recording);
		if (link) {
			const dest = app.metadataCache.getFirstLinkpathDest(link, entry.file.path);
			if (dest instanceof TFile) recording = dest;
		}

		map.set(entry.eventId, { file: entry.file, status: entry.status, recording });
	}
	return map;
}

/** Maps a raw calendar event + note index into the agenda view-model. */
export function toAgendaMeeting(
	ev: GCalEvent,
	index: Map<string, NoteIndexEntry>
): AgendaMeeting {
	const state = index.get(ev.id);
	return {
		id: ev.id,
		title: ev.summary,
		start: ev.start,
		end: ev.end,
		allDay: ev.allDay,
		meetingUrl: ev.meetLink,
		location: ev.location,
		htmlLink: ev.htmlLink,
		attendees: ev.attendees,
		organizer: ev.organizer,
		iCalUID: ev.iCalUID,
		recurringEventId: ev.recurringEventId,
		oneOnOnePartner: ev.oneOnOnePartner,
		oneOnOnePartnerEmail: ev.oneOnOnePartnerEmail,
		note: state?.file ?? null,
		recording: state?.recording ?? null,
		status: state?.status ?? null,
	};
}

/** Converts the view-model back into the note builder's input. */
export function toMeetingInfo(m: AgendaMeeting): MeetingEventInfo {
	return {
		id: m.id,
		summary: m.title,
		start: m.start,
		end: m.end,
		meetLink: m.meetingUrl,
		location: m.location,
		htmlLink: m.htmlLink,
		attendees: m.attendees,
		organizer: m.organizer,
		iCalUID: m.iCalUID,
		recurringEventId: m.recurringEventId,
		oneOnOnePartner: m.oneOnOnePartner,
		oneOnOnePartnerEmail: m.oneOnOnePartnerEmail,
	};
}
