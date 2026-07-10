export interface ScheduledEvent {
	id: string;
	summary: string;
	start: number; // epoch ms
	end: number; // epoch ms
	meetLink: string | null;
	location: string;
	htmlLink: string;
	attendees: string[];
	organizer: string | null;
	iCalUID: string | null;
	recurringEventId: string | null;
}

export interface SchedulerDeps {
	now: () => number;
	fetchEvents: (timeMinMs: number, timeMaxMs: number) => Promise<ScheduledEvent[]>;
	onEventStart: (event: ScheduledEvent) => void;
	onEventEnd: (event: ScheduledEvent) => void;
	onError?: (message: string) => void;
	/** Optional hook to register each interval with the plugin lifecycle (auto-cleared on unload). */
	registerInterval?: (id: number) => void;
}

/** A boundary fires only if the clock is at/after it but within this window. */
export const GRACE_MS = 2 * 60 * 1000;
/** How far ahead each poll fetches events. */
export const POLL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Default cadence for re-fetching the calendar. */
export const POLL_INTERVAL_MS = 5 * 60 * 1000;
/** Default cadence for checking event boundaries. */
export const TICK_INTERVAL_MS = 30 * 1000;

interface Phase {
	started: boolean;
	ended: boolean;
}

export class CalendarScheduler {
	private events: ScheduledEvent[] = [];
	private phase = new Map<string, Phase>();
	private pollTimer: number | null = null;
	private tickTimer: number | null = null;

	constructor(private readonly deps: SchedulerDeps) {}

	/** Fetch events into the cache and prune phase state for events no longer present. */
	async poll(): Promise<void> {
		const now = this.deps.now();
		try {
			this.events = await this.deps.fetchEvents(now - GRACE_MS, now + POLL_WINDOW_MS);
		} catch (e) {
			this.deps.onError?.(e instanceof Error ? e.message : String(e));
			return;
		}
		const ids = new Set(this.events.map((e) => e.id));
		for (const id of [...this.phase.keys()]) {
			if (!ids.has(id)) this.phase.delete(id);
		}
	}

	/** Fire start/end callbacks for any boundary crossed since the last tick. */
	tick(): void {
		const now = this.deps.now();
		for (const event of this.events) {
			const p = this.phase.get(event.id) ?? { started: false, ended: false };
			if (!p.started && now >= event.start && now - event.start < GRACE_MS) {
				p.started = true;
				this.deps.onEventStart(event);
			}
			if (!p.ended && now >= event.end && now - event.end < GRACE_MS) {
				p.ended = true;
				this.deps.onEventEnd(event);
			}
			this.phase.set(event.id, p);
		}
	}

	start(pollIntervalMs = POLL_INTERVAL_MS, tickIntervalMs = TICK_INTERVAL_MS): void {
		if (this.pollTimer !== null) return;
		void this.poll();
		this.pollTimer = window.setInterval(() => void this.poll(), pollIntervalMs);
		this.deps.registerInterval?.(this.pollTimer);
		this.tickTimer = window.setInterval(() => this.tick(), tickIntervalMs);
		this.deps.registerInterval?.(this.tickTimer);
	}

	stop(): void {
		if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
		if (this.tickTimer !== null) window.clearInterval(this.tickTimer);
		this.pollTimer = null;
		this.tickTimer = null;
	}

	get isRunning(): boolean {
		return this.pollTimer !== null;
	}
}
