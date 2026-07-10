// Portions adapted from obsidian-meetings-plus (0BSD)
// https://github.com/jabaho9523/obsidian-meetings-plus
// See THIRD_PARTY_NOTICES.md.

import { moment, setIcon } from "obsidian";
import { t } from "../../../i18n";
import { DatePicker } from "./datePicker";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 180;

export interface StatusHeaderOptions {
	parent: HTMLElement;
	/** One-line status shown under the date (auth/loading/last-refresh). */
	subtext: string;
	lookAheadDays: number;
	/** YYYY-MM-DD currently focused. */
	focusedDay: string;
	/** YYYY-MM-DD of today. */
	today: string;
	/** Earliest navigable day (today − lookBackDays), YYYY-MM-DD. */
	minDay: string;
	/** Set of day keys that have at least one meeting (for picker dots). */
	daysWithMeetings: Set<string>;
	onRefresh: () => void;
	onOpenSettings: () => void;
	onPickDay: (key: string) => void;
	onChangeDays: (n: number) => void;
}

export function renderStatusHeader(opts: StatusHeaderOptions): void {
	const a = t().agenda;
	const root = opts.parent.createDiv({ cls: "meeting-copilot-status" });

	const top = root.createDiv({ cls: "meeting-copilot-status-top" });
	const left = top.createDiv({ cls: "meeting-copilot-status-left" });
	left.createDiv({
		cls: "meeting-copilot-status-title",
		text: moment().format("dddd, MMM D"),
	});
	left.createDiv({
		cls: "meeting-copilot-status-sub",
		text: opts.subtext,
	});

	const actions = top.createDiv({ cls: "meeting-copilot-status-actions" });
	const refresh = actions.createEl("button", {
		cls: "meeting-copilot-icon-btn",
		attr: { "aria-label": a.refresh },
	});
	setIcon(refresh, "refresh-cw");
	refresh.addEventListener("click", () => opts.onRefresh());

	const settings = actions.createEl("button", {
		cls: "meeting-copilot-icon-btn",
		attr: { "aria-label": a.openSettings },
	});
	setIcon(settings, "settings");
	settings.addEventListener("click", () => opts.onOpenSettings());

	renderDateBar(root, opts);
}

function renderDateBar(parent: HTMLElement, opts: StatusHeaderOptions): void {
	const a = t().agenda;
	const focusedDate = dateFromKey(opts.focusedDay);

	const bar = parent.createDiv({ cls: "meeting-copilot-datebar" });

	const prev = bar.createEl("button", {
		cls: "meeting-copilot-icon-btn",
		attr: { "aria-label": a.previousDay },
	});
	setIcon(prev, "chevron-left");
	if (opts.focusedDay <= opts.minDay) prev.setAttribute("disabled", "true");
	prev.addEventListener("click", () => {
		if (opts.focusedDay <= opts.minDay) return;
		const next = new Date(focusedDate.getTime() - DAY_MS);
		opts.onPickDay(keyFromDate(next));
	});

	const label = bar.createEl("button", {
		cls: "meeting-copilot-datebar-label",
		text: labelFor(focusedDate, opts.today),
	});

	let picker: DatePicker | null = null;
	label.addEventListener("click", () => {
		if (picker?.isOpen()) {
			picker.close();
			picker = null;
			return;
		}
		picker = new DatePicker({
			anchor: label,
			focusedDay: opts.focusedDay,
			today: opts.today,
			minDay: opts.minDay,
			daysWithMeetings: opts.daysWithMeetings,
			onPick: (k) => opts.onPickDay(k),
		});
		picker.open();
	});

	const next = bar.createEl("button", {
		cls: "meeting-copilot-icon-btn",
		attr: { "aria-label": a.nextDay },
	});
	setIcon(next, "chevron-right");
	next.addEventListener("click", () => {
		const np = new Date(focusedDate.getTime() + DAY_MS);
		opts.onPickDay(keyFromDate(np));
	});

	renderDaysPill(bar, opts);

	if (opts.focusedDay !== opts.today) {
		const todayBtn = bar.createEl("button", {
			cls: "meeting-copilot-datebar-today",
			text: a.todayLabel,
		});
		todayBtn.addEventListener("click", () => opts.onPickDay(opts.today));
	}
}

function renderDaysPill(bar: HTMLElement, opts: StatusHeaderOptions): void {
	const a = t().agenda;
	const pill = bar.createEl("button", {
		cls: "meeting-copilot-datebar-days",
		text: `${opts.lookAheadDays}d`,
		attr: { "aria-label": a.daysShown },
	});
	pill.addEventListener("click", () => {
		const input = bar.createEl("input", {
			cls: "meeting-copilot-datebar-days-input",
			attr: {
				type: "number",
				min: "1",
				max: String(MAX_DAYS),
				value: String(opts.lookAheadDays),
				"aria-label": a.daysShown,
			},
		});
		pill.replaceWith(input);
		input.focus();
		input.select();

		let committed = false;
		const commit = () => {
			if (committed) return;
			committed = true;
			const n = parseInt(input.value, 10);
			if (Number.isFinite(n) && n >= 1 && n <= MAX_DAYS) {
				if (n !== opts.lookAheadDays) opts.onChangeDays(n);
				else input.replaceWith(pill);
			} else {
				input.replaceWith(pill);
			}
		};
		const cancel = () => {
			if (committed) return;
			committed = true;
			input.replaceWith(pill);
		};
		input.addEventListener("blur", commit);
		input.addEventListener("keydown", (evt) => {
			if (evt.key === "Enter") {
				evt.preventDefault();
				commit();
			} else if (evt.key === "Escape") {
				evt.preventDefault();
				cancel();
			}
		});
	});
}

function labelFor(d: Date, todayKey: string): string {
	const k = keyFromDate(d);
	if (k === todayKey) return moment(d).format("[Today] · ddd, MMM D");
	return moment(d).format("ddd, MMM D");
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
