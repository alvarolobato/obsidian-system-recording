// Portions adapted from obsidian-meetings-plus (0BSD)
// https://github.com/jabaho9523/obsidian-meetings-plus
// See THIRD_PARTY_NOTICES.md.

import { Menu, moment, setIcon } from "obsidian";
import { t } from "../../../i18n";
import type { AgendaMeeting } from "../agendaModel";

export interface RowHandlers {
	/** Primary row click: open the note if it exists, otherwise create it. */
	onOpenOrCreate: (m: AgendaMeeting) => void;
	onCreateAndRecord: (m: AgendaMeeting) => void;
	onCreateNote: (m: AgendaMeeting) => void;
	onStop: () => void;
	onOpenRecording: (m: AgendaMeeting) => void;
	/**
	 * Re-transcribe the meeting's recording. `mode` picks whether to run
	 * speaker separation ("diarized") or transcribe the single joint track
	 * ("mixed"), independent of the plugin's default setting.
	 */
	onTranscribe: (m: AgendaMeeting, mode: "diarized" | "mixed") => void;
	onEnrich: (m: AgendaMeeting) => void;
	onOpenLink: ((m: AgendaMeeting) => void) | null;
	onCopyLink: ((m: AgendaMeeting) => void) | null;
	onSkip: (m: AgendaMeeting) => void;
	/** True when this meeting is the one currently being recorded. */
	isRecordingThis: (m: AgendaMeeting) => boolean;
}

export interface MeetingRowOptions {
	parent: HTMLElement;
	meeting: AgendaMeeting;
	now: number;
	handlers: RowHandlers;
}

function iconButton(
	parent: HTMLElement,
	icon: string,
	label: string,
	onClick: () => void,
	extraCls?: string
): void {
	const btn = parent.createEl("button", {
		cls: extraCls
			? `meeting-copilot-row-action ${extraCls}`
			: "meeting-copilot-row-action",
		attr: { "aria-label": label },
	});
	setIcon(btn, icon);
	btn.addEventListener("click", (evt) => {
		evt.stopPropagation();
		onClick();
	});
}

export function renderMeetingRow(opts: MeetingRowOptions): void {
	const { meeting, handlers, now } = opts;
	const a = t().agenda;
	const row = opts.parent.createDiv({ cls: "meeting-copilot-row" });
	if (meeting.note) row.addClass("meeting-copilot-row-has-note");

	const dot = row.createDiv({ cls: "meeting-copilot-calendar-dot" });
	if (meeting.recording) dot.addClass("meeting-copilot-dot-recorded");

	const time = row.createDiv({ cls: "meeting-copilot-row-time" });
	if (meeting.allDay) {
		time.setText(a.allDay);
	} else {
		time.setText(
			`${moment(meeting.start).format("HH:mm")}–${moment(meeting.end).format(
				"HH:mm"
			)}`
		);
	}

	const main = row.createDiv({ cls: "meeting-copilot-row-main" });
	main.createDiv({ cls: "meeting-copilot-row-title", text: meeting.title });
	const metaParts: string[] = [];
	if (meeting.location) metaParts.push(meeting.location);
	if (meeting.attendees.length > 0) {
		metaParts.push(a.attendeesCount(meeting.attendees.length));
	}
	if (metaParts.length > 0) {
		main.createDiv({
			cls: "meeting-copilot-row-meta",
			text: metaParts.join(" · "),
		});
	}

	const trail = row.createDiv({ cls: "meeting-copilot-row-trail" });

	const recordingThis = handlers.isRecordingThis(meeting);
	const isLive = meeting.start.getTime() <= now && meeting.end.getTime() > now;
	const isUpcoming = meeting.start.getTime() > now;

	if (recordingThis) {
		iconButton(
			trail,
			"square",
			a.actions.stop,
			() => handlers.onStop(),
			"meeting-copilot-row-action-danger"
		);
	} else if (!meeting.allDay && (isLive || isUpcoming || meeting.recording)) {
		// Offer record even when a recording already exists (a second take
		// extends the same meeting), relabeled so it's clearly additive.
		const label = meeting.recording ? a.actions.recordAgain : a.actions.record;
		iconButton(trail, "mic", label, () =>
			handlers.onCreateAndRecord(meeting)
		);
	}

	if (meeting.recording) {
		iconButton(trail, "file-check", a.actions.openRecording, () =>
			handlers.onOpenRecording(meeting)
		);
	}

	if (meeting.note && (meeting.status === "transcribed" || meeting.recording)) {
		iconButton(trail, "sparkles", a.actions.enrich, () =>
			handlers.onEnrich(meeting)
		);
	}

	if (meeting.meetingUrl && handlers.onOpenLink) {
		iconButton(trail, "video", a.actions.openLink, () =>
			handlers.onOpenLink!(meeting)
		);
	}

	row.addEventListener("click", () => handlers.onOpenOrCreate(meeting));
	row.addEventListener("contextmenu", (evt) => {
		evt.preventDefault();
		buildRowContextMenu(meeting, handlers).showAtMouseEvent(evt);
	});
}

export interface MeetingMenuOptions {
	/**
	 * Include agenda-list-only navigation items (open/create note, skip today).
	 * Off when the menu is shown from inside a note, where those don't apply.
	 */
	includeNavigation?: boolean;
}

/**
 * Adds the contextual meeting actions to an existing menu. Shared by the agenda
 * row's right-click menu and the note editor/file context menus, so both stay
 * in sync.
 */
export function populateMeetingMenu(
	menu: Menu,
	meeting: AgendaMeeting,
	handlers: RowHandlers,
	opts: MeetingMenuOptions = {}
): void {
	const a = t().agenda;

	if (opts.includeNavigation) {
		if (meeting.note) {
			menu.addItem((item) =>
				item
					.setTitle(a.actions.openNote)
					.setIcon("file-text")
					.onClick(() => handlers.onOpenOrCreate(meeting))
			);
		} else {
			menu.addItem((item) =>
				item
					.setTitle(a.actions.createNote)
					.setIcon("file-plus-2")
					.onClick(() => handlers.onCreateNote(meeting))
			);
		}
	}

	// Record is offered even when a recording already exists: a new take is
	// appended to the same meeting (and a silent first take auto-discards), so
	// the user is never stuck having to delete a recording to record again.
	if (!handlers.isRecordingThis(meeting)) {
		menu.addItem((item) =>
			item
				.setTitle(
					meeting.recording
						? t().event.recordAgain
						: t().event.createNoteAndRecord
				)
				.setIcon("mic")
				.onClick(() => handlers.onCreateAndRecord(meeting))
		);
	}

	if (handlers.isRecordingThis(meeting)) {
		menu.addItem((item) =>
			item
				.setTitle(a.actions.stop)
				.setIcon("square")
				.onClick(() => handlers.onStop())
		);
	}

	if (meeting.recording) {
		menu.addItem((item) =>
			item
				.setTitle(a.actions.openRecording)
				.setIcon("file-check")
				.onClick(() => handlers.onOpenRecording(meeting))
		);
		// Offer both re-transcribe paths regardless of the default setting: with
		// speaker separation (me/them) and from the single joint track. The
		// diarized option falls back to the joint track when no separate tracks
		// were recorded.
		menu.addItem((item) =>
			item
				.setTitle(a.actions.transcribeDiarized)
				.setIcon("captions")
				.onClick(() => handlers.onTranscribe(meeting, "diarized"))
		);
		menu.addItem((item) =>
			item
				.setTitle(a.actions.transcribeMixed)
				.setIcon("captions")
				.onClick(() => handlers.onTranscribe(meeting, "mixed"))
		);
	}

	if (meeting.note) {
		menu.addItem((item) =>
			item
				.setTitle(a.actions.enrich)
				.setIcon("sparkles")
				.onClick(() => handlers.onEnrich(meeting))
		);
	}

	if (meeting.meetingUrl && handlers.onOpenLink) {
		menu.addItem((item) =>
			item
				.setTitle(a.actions.openLink)
				.setIcon("video")
				.onClick(() => handlers.onOpenLink!(meeting))
		);
	}
	if (meeting.meetingUrl && handlers.onCopyLink) {
		menu.addItem((item) =>
			item
				.setTitle(a.actions.copyLink)
				.setIcon("copy")
				.onClick(() => handlers.onCopyLink!(meeting))
		);
	}

	if (opts.includeNavigation) {
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(a.actions.skipToday)
				.setIcon("eye-off")
				.onClick(() => handlers.onSkip(meeting))
		);
	}
}

export function buildRowContextMenu(
	meeting: AgendaMeeting,
	handlers: RowHandlers
): Menu {
	const menu = new Menu();
	populateMeetingMenu(menu, meeting, handlers, { includeNavigation: true });
	return menu;
}
