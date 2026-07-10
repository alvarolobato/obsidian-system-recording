import { App, normalizePath, TFile } from "obsidian";
import { renderTemplate } from "./template";

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

/** How the note's path/name and body are produced from a meeting. */
export interface MeetingNoteConfig {
	/** Base folder for meeting notes. */
	baseFolder: string;
	/** `{{placeholder}}` pattern for the note title / filename. */
	titlePattern: string;
	/** `{{placeholder}}` template for the note body. */
	template: string;
}

export const DEFAULT_TITLE_PATTERN = "{{date}} {{start:HHmm}} {{title}}";

export const DEFAULT_NOTE_TEMPLATE = `# {{title}}

- **When:** {{start:YYYY-MM-DD HH:mm}} – {{end:HH:mm}} ({{duration}} min)
- **Where:** {{location}}
- **Link:** {{meeting_url}}
- **Attendees:** {{attendees}}

## Notes


## Summary


## Action items

`;

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

/**
 * Shared basename for the note and its recording, from the title pattern.
 * Falls back to `YYYY-MM-DD HHmm <Title>` if the pattern renders empty.
 */
export function meetingBasename(ev: MeetingEventInfo, titlePattern: string): string {
	const rendered = sanitizeName(renderTemplate(titlePattern, ev));
	if (rendered && rendered !== "Untitled") return rendered;
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

/** True if the note has an `event_id` that belongs to a *different* meeting. */
function belongsToOtherEvent(app: App, file: TFile, eventId: string): boolean {
	const fm = app.metadataCache.getFileCache(file)?.frontmatter as
		| Record<string, unknown>
		| undefined;
	const existing = fm?.["event_id"];
	return (
		typeof existing === "string" && existing.length > 0 && existing !== eventId
	);
}

/**
 * Picks the note path for this event: reuses the base path when it's free or
 * already belongs to this event; otherwise appends " 2", " 3"… so two distinct
 * meetings that share a title + time never collapse into one note.
 */
function resolveNotePath(
	app: App,
	folder: string,
	basename: string,
	eventId: string
): string {
	let candidate = normalizePath(`${folder}/${basename}.md`);
	for (let n = 2; n < 1000; n++) {
		const file = app.vault.getAbstractFileByPath(candidate);
		if (!(file instanceof TFile) || !belongsToOtherEvent(app, file, eventId)) {
			return candidate;
		}
		candidate = normalizePath(`${folder}/${basename} ${n}.md`);
	}
	return candidate;
}

/**
 * Creates (or reuses) the meeting note and writes its frontmatter. Idempotent:
 * a note at the same path is reused rather than overwritten, so pressing the
 * start button twice for one occurrence is safe. The body comes from the
 * user's template; the frontmatter below is always managed here so the agenda
 * and recording-linking keep working regardless of the template.
 */
export async function createMeetingNote(
	app: App,
	ev: MeetingEventInfo,
	cfg: MeetingNoteConfig
): Promise<MeetingNoteRef> {
	const folder = meetingFolder(cfg.baseFolder, ev);
	await ensureFolder(app, folder);

	const notePath = resolveNotePath(
		app,
		folder,
		meetingBasename(ev, cfg.titlePattern),
		ev.id
	);
	// The resolved path may carry a " 2" suffix; use its actual stem so the
	// colocated recording shares the note's basename.
	const basename = notePath
		.substring(notePath.lastIndexOf("/") + 1)
		.replace(/\.md$/, "");

	const existing = app.vault.getAbstractFileByPath(notePath);
	const file =
		existing instanceof TFile
			? existing
			: await app.vault.create(notePath, renderTemplate(cfg.template, ev));

	await app.fileManager.processFrontMatter(file, (fm) => {
		const f = fm as Record<string, unknown>;
		f.title = ev.summary;
		f.date = dateOnly(ev.start);
		f.start = localIso(ev.start);
		f.end = localIso(ev.end);
		f.event_id = ev.id;
		if (ev.iCalUID) f.ical_uid = ev.iCalUID;
		if (ev.recurringEventId) f.recurring_event_id = ev.recurringEventId;
		if (ev.meetLink) f.meeting_url = ev.meetLink;
		if (ev.location) f.location = ev.location;
		if (ev.organizer) f.organizer = ev.organizer;
		f.attendees = ev.attendees;
		if (!f.status) f.status = "scheduled";
	});

	return { file, notePath, folder, basename };
}

/** Links the saved recording into the note's frontmatter and marks it recorded. */
export async function linkRecording(
	app: App,
	file: TFile,
	recordingFileName: string
): Promise<void> {
	await app.fileManager.processFrontMatter(file, (fm) => {
		const f = fm as Record<string, unknown>;
		f.recording = `[[${recordingFileName}]]`;
		f.status = "recorded";
	});
}
