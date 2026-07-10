import { App, normalizePath, TFile } from "obsidian";

/** Everything the note builder needs, decoupled from the calendar/scheduler types. */
export interface MeetingEventInfo {
	id: string;
	summary: string;
	start: Date;
	end: Date;
	meetLink: string | null;
	location: string;
	htmlLink: string;
	attendees: string[];
	organizer: string | null;
	iCalUID: string | null;
	recurringEventId: string | null;
}

export interface MeetingNoteRef {
	file: TFile;
	notePath: string;
	folder: string;
	basename: string;
}

// Characters Obsidian/most filesystems reject in file names, plus wikilink-hostile ones.
const ILLEGAL = /[\\/:*?"<>|#^[\]]/g;

/** Makes a string safe to use as a file or folder name. */
export function sanitizeName(name: string): string {
	return name.replace(ILLEGAL, " ").replace(/\s+/g, " ").trim() || "Untitled";
}

function pad(n: number): string {
	return String(n).padStart(2, "0");
}

function dateOnly(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function localIso(d: Date): string {
	return `${dateOnly(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** `YYYY-MM-DD HHmm` prefix from a local date, keeping occurrences sortable and unique. */
export function dateTimePrefix(d: Date): string {
	return `${dateOnly(d)} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Folder for a meeting. Recurring events get a per-series subfolder so every
 * occurrence (note + recording) lives together; one-off events go in the base folder.
 */
export function meetingFolder(baseFolder: string, ev: MeetingEventInfo): string {
	const base = (baseFolder.trim().replace(/\/+$/, "") || "Meetings");
	if (ev.recurringEventId) {
		return normalizePath(`${base}/${sanitizeName(ev.summary)}`);
	}
	return normalizePath(base);
}

/** `YYYY-MM-DD HHmm <Title>` — shared basename for the note and its recording. */
export function meetingBasename(ev: MeetingEventInfo): string {
	return `${dateTimePrefix(ev.start)} ${sanitizeName(ev.summary)}`;
}

async function ensureFolder(app: App, folder: string): Promise<void> {
	let cur = "";
	for (const part of folder.split("/")) {
		cur = cur ? `${cur}/${part}` : part;
		if (!(await app.vault.adapter.exists(cur))) {
			await app.vault.createFolder(cur).catch(() => {
				/* created concurrently */
			});
		}
	}
}

function buildBody(ev: MeetingEventInfo): string {
	const parts: string[] = [`# ${ev.summary}`, ""];
	if (ev.meetLink) parts.push(`[Join meeting](${ev.meetLink})`, "");
	if (ev.attendees.length) parts.push(`**Attendees:** ${ev.attendees.join(", ")}`, "");
	parts.push("## Notes", "", "## Summary", "", "## Action items", "");
	return parts.join("\n");
}

/**
 * Creates (or reuses) the meeting note and writes its frontmatter. Idempotent:
 * a note at the same path is reused rather than overwritten, so pressing the
 * start button twice for one occurrence is safe.
 */
export async function createMeetingNote(
	app: App,
	baseFolder: string,
	ev: MeetingEventInfo
): Promise<MeetingNoteRef> {
	const folder = meetingFolder(baseFolder, ev);
	await ensureFolder(app, folder);

	const basename = meetingBasename(ev);
	const notePath = normalizePath(`${folder}/${basename}.md`);

	let file = app.vault.getAbstractFileByPath(notePath);
	if (!(file instanceof TFile)) {
		file = await app.vault.create(notePath, buildBody(ev));
	}
	const tFile = file as TFile;

	await app.fileManager.processFrontMatter(tFile, (fm) => {
		fm.title = ev.summary;
		fm.date = dateOnly(ev.start);
		fm.start = localIso(ev.start);
		fm.end = localIso(ev.end);
		fm.event_id = ev.id;
		if (ev.iCalUID) fm.ical_uid = ev.iCalUID;
		if (ev.recurringEventId) fm.recurring_event_id = ev.recurringEventId;
		if (ev.meetLink) fm.meeting_url = ev.meetLink;
		if (ev.location) fm.location = ev.location;
		if (ev.organizer) fm.organizer = ev.organizer;
		fm.attendees = ev.attendees;
		if (!fm.status) fm.status = "scheduled";
	});

	return { file: tFile, notePath, folder, basename };
}

/** Links the saved recording into the note's frontmatter and marks it recorded. */
export async function linkRecording(
	app: App,
	file: TFile,
	recordingFileName: string
): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm) => {
		fm.recording = `[[${recordingFileName}]]`;
		fm.status = "recorded";
	});
}
