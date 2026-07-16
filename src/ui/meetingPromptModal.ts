import { App, Modal, Setting } from "obsidian";

export interface MeetingPromptModalOptions {
	/** Meeting name, shown as the heading. */
	title: string;
	/** Timing line, e.g. "Starts in 1 min" or "Started 3 min ago". */
	subtitle: string;
	/** When false, the Join / Join & record buttons are hidden (no meeting link). */
	hasLink: boolean;
	joinLabel: string;
	recordLabel: string;
	joinAndRecordLabel: string;
	openNoteLabel: string;
	dismissLabel: string;
	/** Open the meeting link only. */
	onJoin: () => void;
	/** Create the note and start recording only. */
	onRecord: () => void;
	/** Open the link and start recording. */
	onJoinAndRecord: () => void;
	/** Open (creating if needed) the meeting note without recording; null hides the action. */
	onOpenNote: (() => void) | null;
}

/**
 * The rich meeting prompt opened when the user clicks the system notification
 * for an upcoming/starting meeting. Offers Join, Record, (when a link exists)
 * Join & record, and (when provided) Open note, plus a plain dismiss. Each
 * action closes the modal.
 *
 * This modal is the notification's body-click target: the native OS
 * notification carries the actions as buttons, but clicking its *body* (or the
 * button-less web-fallback banner) brings the user here, where the full,
 * richly-laid-out set of choices lives.
 */
export class MeetingPromptModal extends Modal {
	constructor(
		app: App,
		private readonly opts: MeetingPromptModalOptions
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("mc-meeting-prompt");
		contentEl.createEl("h3", { text: this.opts.title });
		contentEl.createEl("p", {
			text: this.opts.subtitle,
			cls: "mc-meeting-prompt-subtitle",
		});

		// Granola-style layout: a combined primary (Join & record) when a link
		// exists, then Join, then Open note; otherwise Record is the primary.
		const setting = new Setting(contentEl);
		if (this.opts.hasLink) {
			setting.addButton((b) =>
				b
					.setButtonText(this.opts.joinAndRecordLabel)
					.setCta()
					.onClick(() => this.run(this.opts.onJoinAndRecord))
			);
			setting.addButton((b) =>
				b
					.setButtonText(this.opts.joinLabel)
					.onClick(() => this.run(this.opts.onJoin))
			);
		} else {
			setting.addButton((b) =>
				b
					.setButtonText(this.opts.recordLabel)
					.setCta()
					.onClick(() => this.run(this.opts.onRecord))
			);
		}
		if (this.opts.onOpenNote) {
			const openNote = this.opts.onOpenNote;
			setting.addButton((b) =>
				b
					.setButtonText(this.opts.openNoteLabel)
					.onClick(() => this.run(openNote))
			);
		}
		setting.addButton((b) =>
			b.setButtonText(this.opts.dismissLabel).onClick(() => this.close())
		);
	}

	private run(action: () => void): void {
		this.close();
		action();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
