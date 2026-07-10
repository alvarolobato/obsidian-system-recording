// Portions adapted from obsidian-meetings-plus (0BSD)
// https://github.com/jabaho9523/obsidian-meetings-plus
// See THIRD_PARTY_NOTICES.md.

import { moment, setIcon } from "obsidian";
import { t } from "../../../i18n";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_NAMES = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

export interface DatePickerOptions {
	/** Element to anchor the popup under (the date label button). */
	anchor: HTMLElement;
	/** YYYY-MM-DD currently focused in the agenda. */
	focusedDay: string;
	/** YYYY-MM-DD of real today. */
	today: string;
	/** Earliest selectable day (today − look-back window), YYYY-MM-DD. */
	minDay: string;
	/** Day keys (YYYY-MM-DD) that have at least one meeting. */
	daysWithMeetings: Set<string>;
	onPick: (key: string) => void;
}

export class DatePicker {
	private el: HTMLElement | null = null;
	private monthStart: Date;
	private outsideHandler: ((e: MouseEvent) => void) | null = null;
	private keyHandler: ((e: KeyboardEvent) => void) | null = null;

	constructor(private opts: DatePickerOptions) {
		const focused = dateFromKey(opts.focusedDay);
		this.monthStart = new Date(focused.getFullYear(), focused.getMonth(), 1);
	}

	isOpen(): boolean {
		return this.el !== null;
	}

	private get doc(): Document {
		return this.opts.anchor.ownerDocument;
	}

	open(): void {
		if (this.el) return;
		const popup = this.doc.body.createDiv({
			cls: "meeting-copilot-picker",
		});
		this.el = popup;
		this.position();
		this.render();

		this.outsideHandler = (e: MouseEvent) => {
			if (!this.el) return;
			const target = e.target as Node | null;
			if (!target) return;
			if (this.el.contains(target) || this.opts.anchor.contains(target)) {
				return;
			}
			this.close();
		};
		this.keyHandler = (e: KeyboardEvent) => {
			if (e.key === "Escape") this.close();
		};
		// Defer so the same click that opened it doesn't immediately close it.
		window.setTimeout(() => {
			if (this.outsideHandler) {
				this.doc.addEventListener("mousedown", this.outsideHandler);
			}
			if (this.keyHandler) {
				this.doc.addEventListener("keydown", this.keyHandler);
			}
		}, 0);
	}

	close(): void {
		if (this.outsideHandler) {
			this.doc.removeEventListener("mousedown", this.outsideHandler);
			this.outsideHandler = null;
		}
		if (this.keyHandler) {
			this.doc.removeEventListener("keydown", this.keyHandler);
			this.keyHandler = null;
		}
		this.el?.remove();
		this.el = null;
	}

	private position(): void {
		if (!this.el) return;
		const r = this.opts.anchor.getBoundingClientRect();
		const popupWidth = 252;
		let left = r.left;
		if (left + popupWidth > window.innerWidth - 8) {
			left = Math.max(8, window.innerWidth - popupWidth - 8);
		}
		this.el.addClass("meeting-copilot-picker-floating");
		this.el.style.setProperty("--mc-picker-left", `${left}px`);
		this.el.style.setProperty("--mc-picker-top", `${r.bottom + 4}px`);
	}

	private render(): void {
		if (!this.el) return;
		this.el.empty();
		const a = t().agenda;

		const header = this.el.createDiv({ cls: "meeting-copilot-picker-header" });
		const prev = header.createEl("button", {
			cls: "meeting-copilot-picker-nav",
			attr: { "aria-label": a.previousMonth },
		});
		setIcon(prev, "chevron-left");
		prev.addEventListener("click", () => {
			this.monthStart = new Date(
				this.monthStart.getFullYear(),
				this.monthStart.getMonth() - 1,
				1
			);
			this.render();
		});

		header.createSpan({
			cls: "meeting-copilot-picker-month",
			text: moment(this.monthStart).format("MMMM YYYY"),
		});

		const next = header.createEl("button", {
			cls: "meeting-copilot-picker-nav",
			attr: { "aria-label": a.nextMonth },
		});
		setIcon(next, "chevron-right");
		next.addEventListener("click", () => {
			this.monthStart = new Date(
				this.monthStart.getFullYear(),
				this.monthStart.getMonth() + 1,
				1
			);
			this.render();
		});

		const names = this.el.createDiv({
			cls: "meeting-copilot-picker-daynames",
		});
		for (const n of DAY_NAMES) {
			names.createSpan({
				cls: "meeting-copilot-picker-dayname",
				text: n,
			});
		}

		const grid = this.el.createDiv({ cls: "meeting-copilot-picker-grid" });
		const firstDow = this.monthStart.getDay(); // 0=Sun
		const mondayOffset = (firstDow + 6) % 7;
		const gridStart = new Date(this.monthStart);
		gridStart.setDate(this.monthStart.getDate() - mondayOffset);

		const focusedKey = this.opts.focusedDay;
		const todayKey = this.opts.today;

		for (let i = 0; i < 42; i++) {
			const d = new Date(gridStart.getTime() + i * DAY_MS);
			const k = keyFromDate(d);
			const inMonth = d.getMonth() === this.monthStart.getMonth();
			const cell = grid.createEl("button", {
				cls: "meeting-copilot-picker-cell",
				text: String(d.getDate()),
			});
			if (!inMonth) cell.addClass("meeting-copilot-picker-other-month");
			if (k === todayKey) cell.addClass("meeting-copilot-picker-today");
			if (k === focusedKey) cell.addClass("meeting-copilot-picker-focused");
			if (this.opts.daysWithMeetings.has(k)) {
				cell.addClass("meeting-copilot-picker-hasevents");
			}
			if (k < this.opts.minDay) {
				cell.setAttribute("disabled", "true");
				continue;
			}
			if (k < todayKey) {
				cell.addClass("meeting-copilot-picker-past");
			}
			cell.addEventListener("click", () => {
				this.opts.onPick(k);
				this.close();
			});
		}
	}
}

function dateFromKey(k: string): Date {
	const [y, m, d] = k.split("-").map((x) => parseInt(x, 10));
	return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

function keyFromDate(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${dd}`;
}
