import { App, normalizePath, TFile } from "obsidian";
import { renderTemplate, renderTemplateWith } from "./template";
import {
	normalizeFolderPath,
	normalizeFolderPathOrEmpty,
	sanitizeName,
	templateStaticRoot,
} from "./paths";

export {
	normalizeFolderPath,
	normalizeFolderPathOrEmpty,
	sanitizeName,
	templateStaticRoot,
};

/** Prefix marking an ad-hoc (unplanned) meeting's synthetic id, e.g. "adhoc-1699999999999". */
export const ADHOC_ID_PREFIX = "adhoc-";

/** True for an ad-hoc meeting's id (see `ADHOC_ID_PREFIX`). */
export function isAdhocId(id: string): boolean {
	return id.startsWith(ADHOC_ID_PREFIX);
}

/**
 * Extracts the link target from a `recording` frontmatter value, stripping the
 * `[[ ]]` wrapper and any `|alias` so it can be passed to
 * `getFirstLinkpathDest`. Returns "" for a non-string / empty value.
 */
export function recordingLinkTarget(rec: unknown): string {
	if (typeof rec !== "string") return "";
	return (
		rec.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0] ?? ""
	).trim();
}

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
	/** The other attendee's display name (or email) for a 1:1; null for anything else. */
	oneOnOnePartner: string | null;
	/** The other attendee's email for a 1:1, lowercased/trimmed; null when unavailable. */
	oneOnOnePartnerEmail: string | null;
}

/** How the note's path/name and body are produced from a meeting. */
export interface MeetingNoteConfig {
	/** `{{placeholder}}` folder template for one-off meetings, e.g. "Meetings/{{year}}". */
	oneOffFolderTemplate: string;
	/** `{{placeholder}}` folder template for a new recurring series, e.g. "Meetings/{{series}}". */
	seriesFolderTemplate: string;
	/** When on, 1:1s get their own per-person folder instead of following the series/one-off rules. */
	oneOnOneSeparately: boolean;
	/** Parent folder for a 1:1's per-person subfolder. */
	oneOnOneFolder: string;
	/** Folder for unplanned (ad-hoc) meetings. */
	adhocFolder: string;
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

function frontmatterOf(app: App, file: TFile): Record<string, unknown> | undefined {
	return app.metadataCache.getFileCache(file)?.frontmatter as
		| Record<string, unknown>
		| undefined;
}

/** The folder holding a note, or "" for the vault root (a root `TFile`'s parent path is "/"). */
export function folderOf(file: TFile): string {
	const path = file.parent?.path ?? "";
	return path === "/" ? "" : path;
}

/** One row of `scanMeetingNotes`: the plugin-relevant frontmatter of a single note. */
export interface MeetingNoteScanEntry {
	file: TFile;
	eventId: string | null;
	recurringEventId: string | null;
	oneOnOneWith: string | null;
	/** `one_on_one_email` frontmatter, trimmed and lowercased; null when absent/empty. */
	oneOnOneEmail: string | null;
	/** `start` frontmatter; falls back to `date` only when `start` itself isn't a non-empty string. */
	stamp: string | null;
	status: string | null;
	/** Raw `recording` frontmatter value (typically a `[[wikilink]]` string), if any. */
	recording: unknown;
	hasMeetingUrl: boolean;
}

function nonEmptyString(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Frontmatter string, trimmed and lowercased; null when missing/empty. Used
 * for `one_on_one_email` so a hand-edited value with different casing or
 * stray whitespace (`Bob@Acme.com `) still lines up with the calendar's own
 * lowercased/trimmed email rather than stranding the series.
 */
function normalizedEmail(v: unknown): string | null {
	const s = nonEmptyString(v)?.trim().toLowerCase();
	return s && s.length > 0 ? s : null;
}

/**
 * A `start`/`date` frontmatter value as a sortable stamp string. YAML parsers
 * can surface an unquoted ISO timestamp as a Date object rather than a
 * string; without this coercion such a note would look unstamped (invisible
 * to sticky-home resolution, flagged as date-less in the attention table).
 */
function stampString(v: unknown): string | null {
	if (v instanceof Date && !Number.isNaN(v.getTime())) return localIso(v);
	return nonEmptyString(v);
}

const DATE_ONLY_STAMP = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parses a `start`/`date` frontmatter stamp as a Date. A bare `YYYY-MM-DD`
 * value (as written by hand, without a time) is treated as local midnight
 * rather than `new Date`'s UTC midnight, which would otherwise shift the day
 * in negative-offset timezones.
 */
export function parseStampDate(stamp: string): Date {
	return new Date(DATE_ONLY_STAMP.test(stamp) ? `${stamp}T00:00:00` : stamp);
}

/**
 * Scans every markdown note once, pulling out the frontmatter fields used for
 * identity lookup (`event_id`), sticky-home resolution (`recurring_event_id`,
 * `one_on_one_with`/`one_on_one_email`), the "Needs attention" table, and
 * retention scoping, all in a single vault pass.
 *
 * Depends on `metadataCache` being populated; shortly after startup a note
 * that was just created or moved outside the plugin may not show up yet
 * (known limitation — resolves itself once the cache catches up).
 */
export function scanMeetingNotes(app: App): MeetingNoteScanEntry[] {
	return app.vault.getMarkdownFiles().map((file) => {
		const fm = frontmatterOf(app, file);
		return {
			file,
			eventId: nonEmptyString(fm?.["event_id"]),
			recurringEventId: nonEmptyString(fm?.["recurring_event_id"]),
			oneOnOneWith: nonEmptyString(fm?.["one_on_one_with"]),
			oneOnOneEmail: normalizedEmail(fm?.["one_on_one_email"]),
			// Each field is checked on its own: `start` can exist but be a YAML
			// Date/number/empty string, which must still fall back to `date`
			// rather than the whole `??` short-circuiting on the first key alone.
			stamp: stampString(fm?.["start"]) ?? stampString(fm?.["date"]),
			status: nonEmptyString(fm?.["status"]),
			recording: fm?.["recording"],
			hasMeetingUrl: nonEmptyString(fm?.["meeting_url"]) !== null,
		};
	});
}

/** A file's modification time, or 0 when `stat` is unavailable (e.g. a test double). */
function mtimeOf(file: TFile): number {
	return file.stat?.mtime ?? 0;
}

/**
 * Picks one file among several equally-identified candidates (e.g. a
 * duplicate `event_id` from a sync-conflict copy): the most recently
 * modified one, tiebreaking on the lexicographically smallest path so the
 * result is deterministic rather than depending on vault iteration order.
 * Null for an empty list.
 */
function preferredByRecency(files: TFile[]): TFile | null {
	let best: TFile | null = null;
	for (const file of files) {
		if (
			!best ||
			mtimeOf(file) > mtimeOf(best) ||
			(mtimeOf(file) === mtimeOf(best) && file.path < best.path)
		) {
			best = file;
		}
	}
	return best;
}

/**
 * The file of the most recently-started entry (by lexicographic max `stamp`)
 * matching `predicate`; entries with no `stamp` are skipped. This is how a
 * series or a 1:1's folder "follows" wherever its notes currently live.
 *
 * When frontmatter was hand-deleted (no `start`/`date` on any matching note),
 * there's no stamped entry to prefer, so this falls back to the matching
 * entry with the greatest `file.stat.mtime` (tiebroken like
 * `preferredByRecency`) rather than treating the series/person as unseen and
 * duplicating its folder at the default template location.
 */
function mostRecentMatching(
	entries: MeetingNoteScanEntry[],
	predicate: (e: MeetingNoteScanEntry) => boolean
): TFile | null {
	let best: TFile | null = null;
	let bestStamp = "";
	const matching: TFile[] = [];
	for (const e of entries) {
		if (!predicate(e)) continue;
		matching.push(e.file);
		if (e.stamp === null) continue;
		if (!best || e.stamp > bestStamp) {
			best = e.file;
			bestStamp = e.stamp;
		}
	}
	return best ?? preferredByRecency(matching);
}

/**
 * Scans the vault for a note whose `event_id` frontmatter matches, so a note
 * that was moved or renamed is still found by identity rather than by the
 * path the plugin would otherwise compute for it. Several notes can carry
 * the same `event_id` (a sync-conflict copy); `preferredByRecency` picks a
 * deterministic winner rather than whichever the vault iterates first.
 * Returns null for an empty id.
 */
export function findNoteByEventId(app: App, eventId: string): TFile | null {
	if (!eventId) return null;
	return preferredByRecency(
		scanMeetingNotes(app)
			.filter((e) => e.eventId === eventId)
			.map((e) => e.file)
	);
}

/**
 * Tokens whose rendered value comes from the event's dates plus a
 * user-authored format string, never from calendar-controlled text. A "/"
 * they produce (e.g. `{{start:YYYY/MM}}`) is the user's own folder layout,
 * so it may nest; each resulting segment is still sanitized.
 */
const DATE_TOKENS = new Set(["date", "start", "end", "year", "month", "duration"]);

/**
 * Renders a folder template with each substituted token's value sanitized
 * before splicing it in. Text tokens (`{{series}}`, `{{title}}`, …) carry
 * calendar-controlled data, so their value is flattened to a single path
 * segment — a "/" or ".." in an event title can't inject an extra folder or
 * walk outside the template's root. Date tokens may nest (see `DATE_TOKENS`).
 * "/" written literally in the template still separates folders as usual.
 */
function renderFolderTemplate(template: string, ev: MeetingEventInfo): string {
	// An empty token value collapses (its segment is dropped by
	// `normalizeFolderPath`) instead of becoming sanitizeName's "Untitled".
	return renderTemplateWith(template, ev, (value, name) => {
		if (value.trim().length === 0) return "";
		if (DATE_TOKENS.has(name)) return normalizeFolderPathOrEmpty(value);
		return sanitizeName(value);
	});
}

/**
 * Folder for a *new* meeting note (only consulted once identity lookup by
 * `event_id` comes up empty). Order: a 1:1 routed separately follows its
 * partner's folder — matched by `one_on_one_email` when the event has one,
 * falling back to the `one_on_one_with` label match (covers notes stamped
 * before email tracking existed, or a partner with no email) — or starts one
 * under `oneOnOneFolder`; a recurring event follows its series' current
 * folder (or renders `seriesFolderTemplate` for a series with no notes yet);
 * an ad-hoc meeting goes to `adhocFolder`; everything else renders
 * `oneOffFolderTemplate`. A 1:1 series is matched by rule 1 before rule 2 when
 * `oneOnOneSeparately` is on; with it off, rule 2 applies.
 */
function resolveMeetingFolderFromScan(
	entries: MeetingNoteScanEntry[],
	ev: MeetingEventInfo,
	cfg: MeetingNoteConfig
): string {
	if (cfg.oneOnOneSeparately && ev.oneOnOnePartner) {
		// Normalized once so a hand-edited event email (different casing/stray
		// whitespace) still lines up with `scanMeetingNotes`' own normalized
		// `oneOnOneEmail`, in both the match below and the conflict guard.
		const partnerEmail = ev.oneOnOnePartnerEmail?.trim().toLowerCase() || null;
		const byEmail = partnerEmail
			? mostRecentMatching(entries, (e) => e.oneOnOneEmail === partnerEmail)
			: null;
		// The label fallback must not adopt a note stamped with a different
		// email: two partners sharing a display name are different people.
		// Notes with no email stamp (predating email tracking, or a partner
		// without an email) stay matchable by label.
		const home =
			byEmail ??
			mostRecentMatching(
				entries,
				(e) =>
					e.oneOnOneWith === ev.oneOnOnePartner &&
					(e.oneOnOneEmail === null ||
						!partnerEmail ||
						e.oneOnOneEmail === partnerEmail)
			);
		if (home) return folderOf(home);
		return normalizeFolderPath(
			`${cfg.oneOnOneFolder}/${sanitizeName(ev.oneOnOnePartner)}`
		);
	}
	if (ev.recurringEventId) {
		const home = mostRecentMatching(
			entries,
			(e) => e.recurringEventId === ev.recurringEventId
		);
		if (home) return folderOf(home);
		return normalizeFolderPath(renderFolderTemplate(cfg.seriesFolderTemplate, ev));
	}
	if (isAdhocId(ev.id)) {
		return normalizeFolderPath(cfg.adhocFolder);
	}
	return normalizeFolderPath(renderFolderTemplate(cfg.oneOffFolderTemplate, ev));
}

/** Public entry point for `resolveMeetingFolderFromScan`, scanning the vault itself. */
export function resolveMeetingFolder(
	app: App,
	ev: MeetingEventInfo,
	cfg: MeetingNoteConfig
): string {
	return resolveMeetingFolderFromScan(scanMeetingNotes(app), ev, cfg);
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
	if (!folder) return;
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
 * Writes the frontmatter this plugin manages, regardless of how the note was
 * found. `one_on_one_with`/`one_on_one_email` are stamped only when
 * `cfg.oneOnOneSeparately` is on — with the toggle off, a 1:1 is just a
 * regular meeting, so its notes don't accumulate 1:1 metadata that would
 * later strand them once the toggle is switched on.
 */
async function stampFrontmatter(
	app: App,
	file: TFile,
	ev: MeetingEventInfo,
	cfg: MeetingNoteConfig
): Promise<void> {
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
		if (cfg.oneOnOneSeparately && ev.oneOnOnePartner) {
			f.one_on_one_with = ev.oneOnOnePartner;
			if (ev.oneOnOnePartnerEmail) f.one_on_one_email = ev.oneOnOnePartnerEmail;
			else delete f.one_on_one_email;
		} else {
			// Clear stale 1:1 identity: the toggle was switched off, or the
			// event is no longer a 1:1. Leaving it would keep steering the
			// sticky 1:1 lookup toward a folder that no longer applies.
			delete f.one_on_one_with;
			delete f.one_on_one_email;
		}
		f.attendees = ev.attendees;
		if (!f.status) f.status = "scheduled";
	});
}

/**
 * Bridges the gap between stamping a new note's `event_id` and
 * `metadataCache` indexing it. Two `createMeetingNote` calls racing for the
 * same event (a double-click, or the scheduler and the agenda both reacting
 * to it) can both run their `scanMeetingNotes`-based identity lookup before
 * the cache has indexed the first call's write, so neither sees the other's
 * note by frontmatter — which would otherwise collapse two distinct
 * same-title events into one note, or send the second call into a create
 * collision. Keyed by event id, valued by the note's path; consulted before
 * the scan and updated on every successful reuse/create.
 */
const recentNoteByEventId = new Map<string, string>();

/** Bounds `recentNoteByEventId`; oldest entries are evicted first. */
const RECENT_NOTE_CACHE_MAX = 200;

function rememberRecentNote(eventId: string, path: string): void {
	// Re-insert so the entry moves to the back of the eviction order.
	recentNoteByEventId.delete(eventId);
	recentNoteByEventId.set(eventId, path);
	if (recentNoteByEventId.size > RECENT_NOTE_CACHE_MAX) {
		for (const oldest of recentNoteByEventId.keys()) {
			recentNoteByEventId.delete(oldest);
			if (recentNoteByEventId.size <= RECENT_NOTE_CACHE_MAX) break;
		}
	}
}

/** Test-only: clears the module-level recent-note cache between test cases. */
export function __resetRecentNoteCache(): void {
	recentNoteByEventId.clear();
}

function refFromFile(file: TFile): MeetingNoteRef {
	return {
		file,
		notePath: file.path,
		folder: folderOf(file),
		basename: file.basename,
	};
}

/**
 * Creates (or reuses) the meeting note and writes its frontmatter. Identity
 * comes first: the recent-note map (see `recentNoteByEventId`), then a note
 * carrying this event's `event_id` anywhere in the vault — found via
 * `preferredByRecency` since a sync-conflict copy can leave more than one —
 * is reused wherever it lives, so a note the user moved is never duplicated.
 * Only when none exists does this compute a fresh path (folder resolution +
 * collision-safe basename) and create it. The body comes from the user's
 * template; the frontmatter below is always managed here so the agenda and
 * recording-linking keep working regardless of the template.
 */
export async function createMeetingNote(
	app: App,
	ev: MeetingEventInfo,
	cfg: MeetingNoteConfig
): Promise<MeetingNoteRef> {
	const reuse = async (file: TFile): Promise<MeetingNoteRef> => {
		await stampFrontmatter(app, file, ev, cfg);
		if (ev.id) rememberRecentNote(ev.id, file.path);
		return refFromFile(file);
	};

	// Catches a just-created note before metadataCache has indexed it (see
	// `recentNoteByEventId`); getAbstractFileByPath doesn't depend on the cache.
	// The mapping can go stale two ways: the note was deleted and its path
	// reclaimed by a DIFFERENT meeting's note, or the user stripped the
	// `event_id` to detach the note from its event. Trust it only while the
	// cache hasn't indexed the file at all (the very lag the map exists to
	// bridge) or while the cached frontmatter still carries this event's id;
	// otherwise drop the entry and fall through to the frontmatter scan.
	const recentPath = ev.id ? recentNoteByEventId.get(ev.id) : undefined;
	if (recentPath && ev.id) {
		const recent = app.vault.getAbstractFileByPath(recentPath);
		if (recent instanceof TFile) {
			const cache = app.metadataCache.getFileCache(recent);
			const cachedId = (
				cache?.frontmatter as Record<string, unknown> | undefined
			)?.["event_id"];
			if (!cache || cachedId === ev.id) return reuse(recent);
		}
		recentNoteByEventId.delete(ev.id);
	}

	// One scan serves both the identity lookup below and the sticky-home
	// lookups inside `resolveMeetingFolderFromScan`.
	const entries = scanMeetingNotes(app);
	const byIdentity = ev.id
		? preferredByRecency(
				entries.filter((e) => e.eventId === ev.id).map((e) => e.file)
			)
		: null;
	if (byIdentity) return reuse(byIdentity);

	const folder = resolveMeetingFolderFromScan(entries, ev, cfg);
	await ensureFolder(app, folder);

	const notePath = resolveNotePath(
		app,
		folder,
		meetingBasename(ev, cfg.titlePattern),
		ev.id
	);

	const existing = app.vault.getAbstractFileByPath(notePath);
	let file: TFile;
	if (existing instanceof TFile) {
		file = existing;
	} else {
		try {
			file = await app.vault.create(notePath, renderTemplate(cfg.template, ev));
		} catch (e) {
			// A concurrent create can win the race between our exists-check
			// above and this call; reuse whatever landed at notePath instead
			// of failing the whole operation.
			const won = app.vault.getAbstractFileByPath(notePath);
			if (!(won instanceof TFile)) throw e;
			file = won;
		}
	}

	return reuse(file);
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

export const TRANSCRIPT_CALLOUT_TITLE = "Transcript";

/**
 * Inserts or replaces a `heading`-delimited section in a markdown body.
 * The section runs from its heading line to the next top-or-second-level
 * heading (or end of file); if absent, the block is appended. Pure/testable.
 */
export function upsertSection(
	content: string,
	heading: string,
	body: string
): string {
	const lines = content.split("\n");
	const headingTrim = heading.trim();
	const block = `${headingTrim}\n\n${body.trim()}`;
	const start = lines.findIndex((l) => l.trim() === headingTrim);

	if (start === -1) {
		const trimmed = content.replace(/\s+$/, "");
		return `${trimmed.length ? `${trimmed}\n\n` : ""}${block}\n`;
	}

	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^#{1,2}\s/.test(lines[i] ?? "")) {
			end = i;
			break;
		}
	}
	const before = lines.slice(0, start).join("\n").replace(/\s+$/, "");
	const after = lines.slice(end).join("\n").replace(/^\s+/, "");
	const parts: string[] = [];
	if (before.length) parts.push(before);
	parts.push(block);
	if (after.length) parts.push(after);
	return `${parts.join("\n\n")}\n`;
}

/**
 * Finds the meeting note a recording belongs to: first the colocated note
 * (same folder + basename — how this plugin saves recordings), otherwise any
 * note whose `recording` frontmatter links the audio file.
 */
export function findMeetingNoteForAudio(app: App, audio: TFile): TFile | null {
	const dir = audio.parent?.path ?? "";
	const colocated = normalizePath(
		`${dir && dir !== "/" ? `${dir}/` : ""}${audio.basename}.md`
	);
	const direct = app.vault.getAbstractFileByPath(colocated);
	if (direct instanceof TFile) return direct;

	for (const file of app.vault.getMarkdownFiles()) {
		const fm = app.metadataCache.getFileCache(file)?.frontmatter as
			| Record<string, unknown>
			| undefined;
		const link = recordingLinkTarget(fm?.["recording"]);
		if (!link) continue;
		const dest = app.metadataCache.getFirstLinkpathDest(link, file.path);
		if (dest instanceof TFile && dest.path === audio.path) return file;
	}
	return null;
}

/**
 * Formats the transcript as a **collapsed** Obsidian callout (folded by
 * default, since you rarely want to read it), each line quoted so blank lines
 * stay inside the callout.
 */
export function formatTranscriptCallout(transcript: string): string {
	const body = transcript
		.trim()
		.split("\n")
		.map((l) => (l.length ? `> ${l}` : ">"))
		.join("\n");
	return `> [!quote]- ${TRANSCRIPT_CALLOUT_TITLE}\n${body}`;
}

/** Removes a previously-inserted transcript (collapsed callout or legacy `## Transcript` heading). */
export function stripTranscript(content: string): string {
	const lines = content.split("\n");
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		// Legacy "## Transcript" heading section: drop to the next heading / EOF.
		if (line.trim() === `## ${TRANSCRIPT_CALLOUT_TITLE}`) {
			i++;
			while (i < lines.length && !/^#{1,2}\s/.test(lines[i] ?? "")) i++;
			i--;
			continue;
		}
		// Collapsed transcript callout: drop the marker + its ">" continuation.
		const marker = new RegExp(
			`^>\\s*\\[![\\w-]+\\][+-]?\\s*${TRANSCRIPT_CALLOUT_TITLE}\\s*$`
		);
		if (marker.test(line)) {
			i++;
			while (i < lines.length && /^>/.test(lines[i] ?? "")) i++;
			i--;
			continue;
		}
		out.push(line);
	}
	return out.join("\n");
}

/** Places the transcript as a collapsed callout at the very bottom of the note body. Pure/testable. */
export function transcriptAtBottom(content: string, transcript: string): string {
	const stripped = stripTranscript(content).replace(/\s+$/, "");
	const block = formatTranscriptCallout(transcript);
	return `${stripped.length ? `${stripped}\n\n` : ""}${block}\n`;
}

/** Writes the transcript into a collapsed callout at the note's bottom and marks it transcribed. */
export async function insertTranscript(
	app: App,
	file: TFile,
	transcript: string
): Promise<void> {
	const content = await app.vault.read(file);
	const next = transcriptAtBottom(content, transcript);
	if (next !== content) await app.vault.modify(file, next);
	await app.fileManager.processFrontMatter(file, (fm) => {
		const f = fm as Record<string, unknown>;
		f.status = "transcribed";
		// Authoritative signal that the transcript text is durably captured in
		// the note. Set only here (the sole writer of the transcript body), so
		// retention can trust it instead of sniffing the body — a template
		// placeholder can't forge it, and it survives the later "enriched"
		// status transition.
		f.transcript_saved = true;
	});
}
