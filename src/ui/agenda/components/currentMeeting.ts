// Portions adapted from obsidian-meetings-plus (0BSD)
// https://github.com/jabaho9523/obsidian-meetings-plus
// See THIRD_PARTY_NOTICES.md.

import { moment, setIcon } from "obsidian";
import { t } from "../../../i18n";
import type { AgendaMeeting } from "../agendaModel";

export interface CurrentMeetingOptions {
	parent: HTMLElement;
	meeting: AgendaMeeting;
	recordingThis: boolean;
	onPrimary: (m: AgendaMeeting) => void;
	onStop: () => void;
	onOpenLink: ((m: AgendaMeeting) => void) | null;
}

export function renderCurrentMeeting(opts: CurrentMeetingOptions): void {
	const { meeting } = opts;
	const a = t().agenda;
	const card = opts.parent.createDiv({ cls: "meeting-copilot-current" });

	const top = card.createDiv({ cls: "meeting-copilot-current-top" });
	const dot = top.createDiv({ cls: "meeting-copilot-calendar-dot" });
	if (meeting.recording) dot.addClass("meeting-copilot-dot-recorded");

	const info = top.createDiv({ cls: "meeting-copilot-current-info" });
	const now = Date.now();
	const status = opts.recordingThis
		? a.recording
		: meeting.start.getTime() <= now
			? a.now
			: a.startsIn(
					Math.max(1, Math.round((meeting.start.getTime() - now) / 60000))
				);
	info.createDiv({ cls: "meeting-copilot-current-status", text: status });
	info.createDiv({ cls: "meeting-copilot-current-title", text: meeting.title });
	info.createDiv({
		cls: "meeting-copilot-current-time",
		text: `${moment(meeting.start).format("HH:mm")}–${moment(
			meeting.end
		).format("HH:mm")}`,
	});

	const actions = card.createDiv({ cls: "meeting-copilot-current-actions" });

	if (opts.recordingThis) {
		const stop = actions.createEl("button", {
			cls: "meeting-copilot-current-cta meeting-copilot-current-cta-danger",
			text: a.actions.stop,
		});
		stop.addEventListener("click", () => opts.onStop());
	} else {
		const primary = actions.createEl("button", {
			cls: "meeting-copilot-current-cta",
			text: meeting.note ? a.actions.openNote : t().event.createNoteAndRecord,
		});
		primary.addEventListener("click", () => opts.onPrimary(meeting));
	}

	if (opts.onOpenLink && meeting.meetingUrl) {
		const linkBtn = actions.createEl("button", {
			cls: "meeting-copilot-current-link",
			attr: { "aria-label": a.actions.openLink },
		});
		setIcon(linkBtn, "video");
		linkBtn.addEventListener("click", () => opts.onOpenLink!(meeting));
	}
}
