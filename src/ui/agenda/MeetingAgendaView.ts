// Portions adapted from obsidian-meetings-plus (0BSD)
// https://github.com/jabaho9523/obsidian-meetings-plus
// See THIRD_PARTY_NOTICES.md.

import { ItemView, WorkspaceLeaf, moment, setIcon } from "obsidian";
import { t } from "../../i18n";
import type { TypedEventBus } from "../../util/events";
import type { AgendaMeeting } from "./agendaModel";
import { renderStatusHeader } from "./components/statusHeader";
import { renderCurrentMeeting } from "./components/currentMeeting";
import { renderMeetingRow, RowHandlers } from "./components/meetingRow";

export const VIEW_TYPE_AGENDA = "meeting-copilot-agenda";
export const AGENDA_ICON = "calendar-clock";

const IMMINENT_WINDOW_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AgendaViewEvents extends Record<string, unknown> {
	/** Emitted whenever meeting/recording state changes and the view should reload. */
	changed: void;
}

/** Everything the agenda view needs from the plugin, kept decoupled for testing. */
export interface AgendaViewHost {
	getLookAhead(): number;
	getLookBack(): number;
	setLookAhead(n: number): void;
	isAuthenticated(): boolean;
	authenticate(): Promise<void>;
	/** Fetch meetings within [fromMs, toMs], enriched with note/recording state. */
	fetchMeetings(fromMs: number, toMs: number): Promise<AgendaMeeting[]>;
	isRecordingThis(meeting: AgendaMeeting): boolean;
	onOpenOrCreate(meeting: AgendaMeeting): void;
	onCreateAndRecord(meeting: AgendaMeeting): void;
	onCreateNote(meeting: AgendaMeeting): void;
	onStop(): void;
	onOpenRecording(meeting: AgendaMeeting): void;
	onTranscribe(meeting: AgendaMeeting): void;
	onOpenLink(url: string): void;
	onCopyLink(url: string): void;
	openSettings(): void;
	events: TypedEventBus<AgendaViewEvents>;
}

export class MeetingAgendaView extends ItemView {
	private earlierTodayCollapsed = true;
	private focusedDay = dayKey(new Date());
	private meetings: AgendaMeeting[] = [];
	private loading = false;
	private errorMsg: string | null = null;
	private lastFetchAt = 0;
	private skipped = new Set<string>();
	private unsub: (() => void) | null = null;
	private tickTimer: number | null = null;
	private pendingScrollKey: string | null = null;
	private reloadSeq = 0;

	constructor(leaf: WorkspaceLeaf, private host: AgendaViewHost) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_AGENDA;
	}

	getDisplayText(): string {
		return t().agenda.title;
	}

	getIcon(): string {
		return AGENDA_ICON;
	}

	onOpen(): Promise<void> {
		this.unsub = this.host.events.on("changed", () => void this.reload());
		// Re-render each minute so "Now / starts in N min" stays fresh.
		this.tickTimer = window.setInterval(() => this.render(), 60_000);
		void this.reload();
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.unsub?.();
		this.unsub = null;
		if (this.tickTimer !== null) {
			window.clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		this.contentEl.empty();
		return Promise.resolve();
	}

	/** Fetches the current window and re-renders. Safe against overlapping calls. */
	async reload(): Promise<void> {
		if (!this.host.isAuthenticated()) {
			this.meetings = [];
			this.render();
			return;
		}
		const seq = ++this.reloadSeq;
		this.loading = true;
		this.render();

		const lookAhead = Math.max(1, this.host.getLookAhead());
		const lookBack = Math.max(0, Math.min(30, this.host.getLookBack()));
		const today = startOfDay(new Date());
		const focused = dateFromKey(this.focusedDay);
		const from = Math.min(today.getTime() - lookBack * DAY_MS, focused.getTime());
		const to =
			Math.max(today.getTime(), focused.getTime()) + lookAhead * DAY_MS;

		try {
			const meetings = await this.host.fetchMeetings(from, to);
			if (seq !== this.reloadSeq) return; // superseded by a newer reload
			this.meetings = meetings;
			this.errorMsg = null;
			this.lastFetchAt = Date.now();
		} catch (e) {
			if (seq !== this.reloadSeq) return;
			this.errorMsg = e instanceof Error ? e.message : String(e);
		} finally {
			if (seq === this.reloadSeq) {
				this.loading = false;
				this.render();
			}
		}
	}

	private subtext(): string {
		const a = t().agenda;
		if (!this.host.isAuthenticated()) return a.notConnected;
		if (this.loading) return a.loading;
		if (this.errorMsg) return this.errorMsg;
		if (this.lastFetchAt === 0) return a.loading;
		return a.lastRefreshed(moment(this.lastFetchAt).fromNow());
	}

	render(): void {
		this.contentEl.empty();
		const a = t().agenda;
		const root = this.contentEl.createDiv({ cls: "meeting-copilot-container" });

		const lookAhead = Math.max(1, this.host.getLookAhead());
		const lookBack = Math.max(0, Math.min(30, this.host.getLookBack()));
		const now = Date.now();
		const today = startOfDay(new Date(now));
		const todayKey = dayKey(today);
		const minKey = dayKey(new Date(today.getTime() - lookBack * DAY_MS));
		if (this.focusedDay < minKey) this.focusedDay = minKey;

		const visible = this.visibleMeetings();
		const daysWithMeetings = new Set(visible.map((m) => dayKey(m.start)));

		renderStatusHeader({
			parent: root,
			subtext: this.subtext(),
			lookAheadDays: lookAhead,
			focusedDay: this.focusedDay,
			today: todayKey,
			minDay: minKey,
			daysWithMeetings,
			onRefresh: () => void this.reload(),
			onOpenSettings: () => this.host.openSettings(),
			onPickDay: (k) => this.jumpToDay(k),
			onChangeDays: (n) => this.changeDays(n),
		});

		if (!this.host.isAuthenticated()) {
			this.renderConnectState(root);
			return;
		}

		if (this.errorMsg) {
			root.createDiv({
				cls: "meeting-copilot-error-row",
				text: this.errorMsg,
			});
		}

		const byDay = new Map<string, AgendaMeeting[]>();
		for (const m of visible) {
			const k = dayKey(m.start);
			if (!byDay.has(k)) byDay.set(k, []);
			byDay.get(k)!.push(m);
		}

		// Current/imminent card — only when focused on today.
		let currentId: string | null = null;
		if (this.focusedDay === todayKey) {
			const todays = byDay.get(todayKey) ?? [];
			const current = todays.find(
				(m) =>
					m.start.getTime() <= now + IMMINENT_WINDOW_MS &&
					m.end.getTime() > now
			);
			if (current) {
				currentId = current.id;
				renderCurrentMeeting({
					parent: root,
					meeting: current,
					recordingThis: this.host.isRecordingThis(current),
					onPrimary: (m) => this.host.onOpenOrCreate(m),
					onStop: () => this.host.onStop(),
					onOpenLink: current.meetingUrl
						? (m) => this.openLink(m)
						: null,
				});
			}
		}

		const focusedDate = dateFromKey(this.focusedDay);
		const agenda = root.createDiv({ cls: "meeting-copilot-agenda" });
		let emptyRun = 0;
		let renderedAny = false;

		for (let i = 0; i < lookAhead; i++) {
			const date = new Date(focusedDate.getTime() + i * DAY_MS);
			const key = dayKey(date);
			const dayMeetings = byDay.get(key) ?? [];
			const isFocusedDay = i === 0;
			const isTodayKey = key === todayKey;

			if (dayMeetings.length === 0 && !isFocusedDay) {
				emptyRun++;
				continue;
			}
			if (emptyRun > 0) {
				this.renderEmptyRun(agenda, emptyRun);
				emptyRun = 0;
			}
			renderedAny = true;
			const label = dayLabel(
				date,
				isTodayKey,
				isTomorrow(date, today),
				isYesterday(date, today)
			);
			this.renderDay(agenda, {
				key,
				label,
				meetings: dayMeetings,
				isToday: isTodayKey,
				isPast: key < todayKey,
				now,
				isFocusedDay,
				currentId,
			});
		}

		if (emptyRun > 0) this.renderEmptyRun(agenda, emptyRun);
		if (!renderedAny && emptyRun === 0) {
			agenda.createDiv({
				cls: "meeting-copilot-empty",
				text: a.nothingScheduled,
			});
		}

		if (this.pendingScrollKey) {
			const target = this.pendingScrollKey;
			this.pendingScrollKey = null;
			window.requestAnimationFrame(() => {
				const el = this.contentEl.querySelector(`[data-day="${target}"]`);
				if (el instanceof HTMLElement) {
					el.scrollIntoView({ behavior: "smooth", block: "start" });
				}
			});
		}
	}

	private renderConnectState(parent: HTMLElement): void {
		const a = t().agenda;
		const box = parent.createDiv({ cls: "meeting-copilot-empty-cta" });
		box.createEl("p", { text: a.connectPrompt });
		const btn = box.createEl("button", {
			cls: "mod-cta",
			text: a.connectCta,
		});
		btn.addEventListener("click", () => {
			void (async () => {
				await this.host.authenticate();
				await this.reload();
			})();
		});
	}

	private renderDay(
		parent: HTMLElement,
		o: {
			key: string;
			label: string;
			meetings: AgendaMeeting[];
			isToday: boolean;
			isPast: boolean;
			now: number;
			isFocusedDay: boolean;
			currentId: string | null;
		}
	): void {
		const a = t().agenda;
		const day = parent.createDiv({ cls: "meeting-copilot-day" });
		day.setAttribute("data-day", o.key);
		if (o.isToday) day.addClass("meeting-copilot-day-today");
		if (o.isPast) day.addClass("meeting-copilot-day-past");

		const header = day.createDiv({ cls: "meeting-copilot-day-header" });
		header.createSpan({ cls: "meeting-copilot-day-label", text: o.label });

		if (o.meetings.length === 0) {
			day.createDiv({
				cls: "meeting-copilot-day-empty-inline",
				text: a.noMeetings,
			});
			return;
		}

		const body = day.createDiv({ cls: "meeting-copilot-day-body" });

		let toRender = o.meetings;
		let earlier: AgendaMeeting[] = [];
		if (o.isToday && o.isFocusedDay) {
			earlier = o.meetings.filter((m) => m.end.getTime() <= o.now);
			toRender = o.meetings.filter(
				(m) => m.end.getTime() > o.now && m.id !== o.currentId
			);
		}

		if (toRender.length === 0 && earlier.length === 0) {
			day.createDiv({
				cls: "meeting-copilot-day-empty-inline",
				text: a.nothingElse,
			});
		}

		for (const meeting of toRender) {
			renderMeetingRow({
				parent: body,
				meeting,
				now: o.now,
				handlers: this.rowHandlers(),
			});
		}

		if (earlier.length > 0) this.renderEarlierToday(day, earlier, o.now);
	}

	private renderEarlierToday(
		parent: HTMLElement,
		meetings: AgendaMeeting[],
		now: number
	): void {
		const a = t().agenda;
		const section = parent.createDiv({
			cls: "meeting-copilot-earlier-section",
		});
		if (this.earlierTodayCollapsed) {
			section.addClass("meeting-copilot-collapsed");
		}
		const header = section.createDiv({ cls: "meeting-copilot-earlier-header" });
		const chevron = header.createSpan({ cls: "meeting-copilot-chevron" });
		setIcon(chevron, "chevron-down");
		header.createSpan({ text: a.earlierToday });
		header.createSpan({
			cls: "meeting-copilot-section-count",
			text: String(meetings.length),
		});
		header.addEventListener("click", () => {
			this.earlierTodayCollapsed = !this.earlierTodayCollapsed;
			this.render();
		});
		const body = section.createDiv({ cls: "meeting-copilot-earlier-body" });
		for (const meeting of meetings) {
			renderMeetingRow({
				parent: body,
				meeting,
				now,
				handlers: this.rowHandlers(),
			});
		}
	}

	private renderEmptyRun(parent: HTMLElement, count: number): void {
		parent.createDiv({
			cls: "meeting-copilot-empty-run",
			text: t().agenda.daysWithoutEvents(count),
		});
	}

	private rowHandlers(): RowHandlers {
		return {
			onOpenOrCreate: (m) => this.host.onOpenOrCreate(m),
			onCreateAndRecord: (m) => this.host.onCreateAndRecord(m),
			onCreateNote: (m) => this.host.onCreateNote(m),
			onStop: () => this.host.onStop(),
			onOpenRecording: (m) => this.host.onOpenRecording(m),
			onTranscribe: (m) => this.host.onTranscribe(m),
			onOpenLink: (m) => this.openLink(m),
			onCopyLink: (m) => {
				if (m.meetingUrl) this.host.onCopyLink(m.meetingUrl);
			},
			onSkip: (m) => {
				this.skipped.add(m.id);
				this.render();
			},
			isRecordingThis: (m) => this.host.isRecordingThis(m),
		};
	}

	private openLink(m: AgendaMeeting): void {
		if (m.meetingUrl) this.host.onOpenLink(m.meetingUrl);
	}

	private jumpToDay(k: string): void {
		this.focusedDay = k;
		this.pendingScrollKey = k;
		void this.reload();
	}

	private changeDays(n: number): void {
		this.host.setLookAhead(n);
		void this.reload();
	}

	private visibleMeetings(): AgendaMeeting[] {
		return this.meetings.filter((m) => !this.skipped.has(m.id));
	}
}

function startOfDay(d: Date): Date {
	const x = new Date(d);
	x.setHours(0, 0, 0, 0);
	return x;
}

export function dayKey(d: Date): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${dd}`;
}

function dateFromKey(k: string): Date {
	const [y, m, d] = k.split("-").map((x) => parseInt(x, 10));
	return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

function isTomorrow(d: Date, today: Date): boolean {
	return dayKey(d) === dayKey(new Date(today.getTime() + DAY_MS));
}

function isYesterday(d: Date, today: Date): boolean {
	return dayKey(d) === dayKey(new Date(today.getTime() - DAY_MS));
}

function dayLabel(
	d: Date,
	isToday: boolean,
	isTom: boolean,
	isYest: boolean
): string {
	const a = t().agenda;
	if (isToday) return a.todayLabel;
	if (isTom) return a.tomorrowLabel;
	if (isYest) return a.yesterdayLabel;
	return moment(d).format("ddd, MMM D");
}
