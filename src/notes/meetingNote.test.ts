import { describe, expect, it } from "vitest";
import { TFile, type App, type TFolder } from "obsidian";
import {
	createMeetingNote,
	DEFAULT_NOTE_TEMPLATE,
	DEFAULT_TITLE_PATTERN,
	formatTranscriptCallout,
	type MeetingEventInfo,
	type MeetingNoteConfig,
	recordingLinkTarget,
	resolveMeetingFolder,
	stripTranscript,
	transcriptAtBottom,
	upsertSection,
} from "./meetingNote";

// --- Fake vault/App, since the mocked "obsidian" module ships no real Vault. ---

interface FakeEntry {
	file: TFile;
	frontmatter: Record<string, unknown>;
}

function makeTFile(path: string): TFile {
	const file = new TFile();
	file.path = path;
	const slash = path.lastIndexOf("/");
	file.name = slash === -1 ? path : path.slice(slash + 1);
	const dot = file.name.lastIndexOf(".");
	file.basename = dot === -1 ? file.name : file.name.slice(0, dot);
	file.extension = dot === -1 ? "" : file.name.slice(dot + 1);
	// eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast -- building a test fixture, not narrowing a real runtime value
	file.parent = { path: slash === -1 ? "" : path.slice(0, slash) } as unknown as TFolder;
	return file;
}

/** In-memory vault + App good enough to exercise the note-creation/folder-resolution logic. */
class FakeVault {
	private entries = new Map<string, FakeEntry>();
	private folders = new Set<string>([""]);
	created: string[] = [];

	/** Seeds an existing note; returns its TFile so a test can reference it. */
	addNote(path: string, frontmatter: Record<string, unknown> = {}): TFile {
		const file = makeTFile(path);
		this.entries.set(path, { file, frontmatter });
		const slash = path.lastIndexOf("/");
		this.folders.add(slash === -1 ? "" : path.slice(0, slash));
		return file;
	}

	getMarkdownFiles(): TFile[] {
		return [...this.entries.values()].map((e) => e.file);
	}

	getAbstractFileByPath(path: string): TFile | null {
		return this.entries.get(path)?.file ?? null;
	}

	async create(path: string, _content: string): Promise<TFile> {
		this.created.push(path);
		const file = makeTFile(path);
		this.entries.set(path, { file, frontmatter: {} });
		return file;
	}

	async createFolder(path: string): Promise<void> {
		this.folders.add(path);
	}

	adapter = {
		exists: async (path: string): Promise<boolean> =>
			this.folders.has(path) || this.entries.has(path),
	};

	frontmatterFor(file: TFile): Record<string, unknown> | undefined {
		return this.entries.get(file.path)?.frontmatter;
	}
}

function makeApp(vault: FakeVault): App {
	return {
		vault,
		metadataCache: {
			getFileCache: (file: TFile) => ({ frontmatter: vault.frontmatterFor(file) }),
		},
		fileManager: {
			processFrontMatter: async (
				file: TFile,
				fn: (fm: Record<string, unknown>) => void
			) => {
				const fm = vault.frontmatterFor(file);
				if (fm) fn(fm);
			},
		},
	} as unknown as App;
}

function ev(overrides: Partial<MeetingEventInfo> = {}): MeetingEventInfo {
	return {
		id: "evt-1",
		summary: "Team Sync",
		start: new Date("2026-07-10T14:00:00"),
		end: new Date("2026-07-10T14:30:00"),
		meetLink: null,
		location: "",
		htmlLink: "",
		attendees: [],
		organizer: null,
		iCalUID: null,
		recurringEventId: null,
		oneOnOnePartner: null,
		...overrides,
	};
}

function cfg(overrides: Partial<MeetingNoteConfig> = {}): MeetingNoteConfig {
	return {
		oneOffFolderTemplate: "Meetings/{{year}}",
		seriesFolderTemplate: "Meetings/{{series}}",
		oneOnOneSeparately: false,
		oneOnOneFolder: "Meetings/1-1s",
		adhocFolder: "Meetings/Ad-hoc",
		titlePattern: DEFAULT_TITLE_PATTERN,
		template: DEFAULT_NOTE_TEMPLATE,
		...overrides,
	};
}

describe("recordingLinkTarget", () => {
	it("strips the [[ ]] wrapper", () => {
		expect(recordingLinkTarget("[[Meetings/foo.wav]]")).toBe(
			"Meetings/foo.wav"
		);
	});
	it("strips a |alias", () => {
		expect(recordingLinkTarget("[[foo.wav|Jan meeting]]")).toBe("foo.wav");
	});
	it("handles a bare path", () => {
		expect(recordingLinkTarget("foo.wav")).toBe("foo.wav");
	});
	it("returns '' for non-string / empty", () => {
		expect(recordingLinkTarget(undefined)).toBe("");
		expect(recordingLinkTarget(42)).toBe("");
		expect(recordingLinkTarget("")).toBe("");
	});
});

describe("upsertSection", () => {
	it("appends the section when it is missing", () => {
		const out = upsertSection("# Title\n\n## Notes\n\nfoo\n", "## Summary", "hello world");
		expect(out).toContain("## Notes\n\nfoo");
		expect(out).toContain("## Summary\n\nhello world");
	});

	it("replaces existing section content, preserving later sections", () => {
		const input = "# T\n\n## Summary\n\nold line\n\n## Action items\n\n- a\n";
		const out = upsertSection(input, "## Summary", "new text");
		expect(out).toContain("## Summary\n\nnew text");
		expect(out).not.toContain("old line");
		expect(out).toContain("## Action items\n\n- a");
	});

	it("handles empty content", () => {
		expect(upsertSection("", "## Summary", "body")).toBe("## Summary\n\nbody\n");
	});
});

describe("formatTranscriptCallout", () => {
	it("uses a collapsed callout and quotes every line", () => {
		const out = formatTranscriptCallout("line one\n\nline two");
		expect(out).toBe("> [!quote]- Transcript\n> line one\n>\n> line two");
	});
});

describe("transcriptAtBottom", () => {
	it("appends the transcript below existing sections", () => {
		const out = transcriptAtBottom("# T\n\n## Notes\n\nmy note\n", "hello");
		expect(out).toContain("## Notes\n\nmy note");
		expect(out.trimEnd().endsWith("> hello")).toBe(true);
		expect(out).toContain("> [!quote]- Transcript");
	});

	it("replaces an existing transcript callout and keeps it at the bottom", () => {
		const first = transcriptAtBottom("# T\n\n## Summary\n\ns\n", "old transcript");
		const second = transcriptAtBottom(first, "new transcript");
		expect(second).toContain("> new transcript");
		expect(second).not.toContain("old transcript");
		// Only one transcript callout remains.
		expect(second.match(/\[!quote\]- Transcript/g)?.length).toBe(1);
		// Summary stays above the transcript.
		expect(second.indexOf("## Summary")).toBeLessThan(second.indexOf("[!quote]"));
	});

	it("migrates a legacy '## Transcript' heading section to a bottom callout", () => {
		const legacy = "# T\n\n## Transcript\n\nold body\n\n## Action items\n\n- a\n";
		const out = transcriptAtBottom(legacy, "fresh");
		expect(out).not.toContain("## Transcript");
		expect(out).not.toContain("old body");
		expect(out).toContain("## Action items\n\n- a");
		expect(out.trimEnd().endsWith("> fresh")).toBe(true);
	});
});

describe("stripTranscript", () => {
	it("returns content unchanged when there is no transcript", () => {
		const input = "# T\n\n## Notes\n\nfoo";
		expect(stripTranscript(input)).toBe(input);
	});
});

describe("createMeetingNote", () => {
	it("reuses a note found by event_id wherever it lives, without creating a new one", async () => {
		const vault = new FakeVault();
		const moved = vault.addNote("Somewhere/Weird Name.md", {
			event_id: "evt-1",
			title: "Old Title",
		});
		const app = makeApp(vault);

		const ref = await createMeetingNote(app, ev({ id: "evt-1", summary: "New Title" }), cfg());

		expect(ref.file).toBe(moved);
		expect(ref.folder).toBe("Somewhere");
		expect(ref.basename).toBe("Weird Name");
		expect(ref.notePath).toBe("Somewhere/Weird Name.md");
		expect(vault.created).toEqual([]);
		expect(vault.frontmatterFor(moved)?.title).toBe("New Title");
	});

	it("creates a new note at the resolved path when no note matches the event_id", async () => {
		const vault = new FakeVault();
		const app = makeApp(vault);

		const ref = await createMeetingNote(app, ev({ id: "evt-2" }), cfg());

		expect(vault.created).toEqual([ref.notePath]);
		expect(ref.folder).toBe("Meetings/2026");
	});
});

describe("resolveMeetingFolder", () => {
	it("follows the series' current folder (sticky series home)", () => {
		const vault = new FakeVault();
		vault.addNote("Projects/Weekly/2026-06-01.md", {
			recurring_event_id: "rec-1",
			start: "2026-06-01T10:00:00",
		});
		vault.addNote("Projects/Weekly/2026-06-08.md", {
			recurring_event_id: "rec-1",
			start: "2026-06-08T10:00:00",
		});
		const app = makeApp(vault);

		const folder = resolveMeetingFolder(app, ev({ recurringEventId: "rec-1" }), cfg());
		expect(folder).toBe("Projects/Weekly");
	});

	it("renders the series folder template for a series with no notes yet", () => {
		const app = makeApp(new FakeVault());
		const folder = resolveMeetingFolder(
			app,
			ev({ recurringEventId: "rec-new", summary: "Design Review" }),
			cfg()
		);
		expect(folder).toBe("Meetings/Design Review");
	});

	it("defaults a 1:1's first note to <oneOnOneFolder>/<partner>", () => {
		const app = makeApp(new FakeVault());
		const folder = resolveMeetingFolder(
			app,
			ev({ oneOnOnePartner: "Bob" }),
			cfg({ oneOnOneSeparately: true })
		);
		expect(folder).toBe("Meetings/1-1s/Bob");
	});

	it("follows a 1:1 partner's folder even after it was moved (via one_on_one_with)", () => {
		const vault = new FakeVault();
		vault.addNote("Somewhere/Bob Chats/2026-05-01.md", {
			one_on_one_with: "Bob",
			start: "2026-05-01T10:00:00",
		});
		const app = makeApp(vault);

		const folder = resolveMeetingFolder(
			app,
			ev({ oneOnOnePartner: "Bob" }),
			cfg({ oneOnOneSeparately: true })
		);
		expect(folder).toBe("Somewhere/Bob Chats");
	});

	it("falls through to the series/one-off rules when the 1:1 toggle is off", () => {
		const app = makeApp(new FakeVault());
		const folder = resolveMeetingFolder(
			app,
			ev({ oneOnOnePartner: "Bob", recurringEventId: null }),
			cfg({ oneOnOneSeparately: false })
		);
		expect(folder).toBe("Meetings/2026");
	});

	it("routes an ad-hoc id (adhoc-*) to the ad-hoc folder", () => {
		const app = makeApp(new FakeVault());
		const folder = resolveMeetingFolder(app, ev({ id: "adhoc-12345" }), cfg());
		expect(folder).toBe("Meetings/Ad-hoc");
	});

	it("renders {{year}} in the one-off template", () => {
		const app = makeApp(new FakeVault());
		const folder = resolveMeetingFolder(
			app,
			ev({ start: new Date("2027-01-05T09:00:00") }),
			cfg()
		);
		expect(folder).toBe("Meetings/2027");
	});

	it("sanitizes an illegal character from a rendered template segment", () => {
		const app = makeApp(new FakeVault());
		const folder = resolveMeetingFolder(
			app,
			ev({ summary: "Weird: Title" }),
			cfg({ oneOffFolderTemplate: "Meetings/{{title}}" })
		);
		expect(folder).toBe("Meetings/Weird Title");
	});
});
