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
	/** The other attendee's display name (or email) for a 1:1; null for anything else. */
	oneOnOnePartner: string | null;
	/** The other attendee's email for a 1:1 (lowercased/trimmed); null when unavailable. */
	oneOnOnePartnerEmail: string | null;
}

export interface SchedulerDeps {
	now: () => number;
	fetchEvents: (timeMinMs: number, timeMaxMs: number) => Promise<ScheduledEvent[]>;
	/**
	 * Fired once, `leadMs` before an event's start (only when a positive lead is
	 * configured and the clock is still before the start). Lets the plugin warn
	 * the user a meeting is about to begin. Optional for back-compat.
	 */
	onEventUpcoming?: (event: ScheduledEvent) => void;
	onEventStart: (event: ScheduledEvent) => void;
	onEventEnd: (event: ScheduledEvent) => void;
	onError?: (message: string) => void;
	/**
	 * How long before an event's start the upcoming notification should fire, in
	 * ms. Read on every tick so a settings change takes effect immediately. 0 (or
	 * omitted) disables the upcoming boundary — the start boundary still fires.
	 */
	leadMs?: () => number;
	/** Optional hook to register each interval with the plugin lifecycle (auto-cleared on unload). */
	registerInterval?: (id: number) => void;
}

/**
 * Grace window used to tell a "live" boundary crossing (fired within this of the
 * boundary) from a stale one recovered after a gap. The plugin uses it to decide
 * whether a just-fired end means "offer to stop" vs "force stop" (a recording
 * that outlived its meeting). The end boundary itself has no upper bound so a
 * crossing missed while asleep still fires on wake.
 */
export const GRACE_MS = 2 * 60 * 1000;
/** How far ahead each poll fetches events. */
export const POLL_WINDOW_MS = 24 * 60 * 60 * 1000;
/**
 * How far *back* each poll fetches events. Wide enough that a meeting still in
 * progress after the laptop wakes (or the plugin reloads) is refetched and can
 * be recovered — a start prompt for a late join, or an end/auto-stop for one
 * that finished while asleep — rather than dropped once it slips past `now`.
 */
export const POLL_LOOKBACK_MS = 4 * 60 * 60 * 1000;
/** Default cadence for re-fetching the calendar. */
export const POLL_INTERVAL_MS = 5 * 60 * 1000;
/** Default cadence for checking event boundaries. */
export const TICK_INTERVAL_MS = 30 * 1000;
/**
 * A gap between ticks larger than this means the machine likely slept (or the
 * event loop was frozen); force an immediate re-poll so boundaries are checked
 * against fresh calendar data instead of a stale pre-sleep snapshot.
 */
export const WAKE_GAP_MS = 3 * TICK_INTERVAL_MS;

interface Phase {
	upcoming: boolean;
	started: boolean;
	ended: boolean;
}

export class CalendarScheduler {
	private events: ScheduledEvent[] = [];
	private phase = new Map<string, Phase>();
	private pollTimer: number | null = null;
	private tickTimer: number | null = null;
	/** Wall-clock of the previous tick, for sleep/freeze detection. */
	private lastTickAt: number | null = null;

	constructor(private readonly deps: SchedulerDeps) {}

	/** Fetch events into the cache and prune phase state for events no longer present. */
	async poll(): Promise<void> {
		const now = this.deps.now();
		try {
			this.events = await this.deps.fetchEvents(
				now - POLL_LOOKBACK_MS,
				now + POLL_WINDOW_MS
			);
		} catch (e) {
			this.deps.onError?.(e instanceof Error ? e.message : String(e));
			return;
		}
		const ids = new Set(this.events.map((e) => e.id));
		for (const id of [...this.phase.keys()]) {
			if (!ids.has(id)) this.phase.delete(id);
		}
	}

	/** Fire upcoming/start/end callbacks for any boundary crossed since the last tick. */
	tick(): void {
		const now = this.deps.now();
		// A large jump since the last tick means we likely slept; refresh the
		// calendar so recovery decisions below use current data (async — this
		// tick still runs against the cached snapshot, the next runs on fresh).
		if (this.lastTickAt !== null && now - this.lastTickAt > WAKE_GAP_MS) {
			void this.poll();
		}
		this.lastTickAt = now;

		const leadMs = Math.max(0, this.deps.leadMs?.() ?? 0);
		for (const event of this.events) {
			const p =
				this.phase.get(event.id) ??
				({ upcoming: false, started: false, ended: false } as Phase);

			// Upcoming: once, in the lead window strictly before the start.
			if (
				!p.upcoming &&
				leadMs > 0 &&
				now >= event.start - leadMs &&
				now < event.start
			) {
				p.upcoming = true;
				this.deps.onEventUpcoming?.(event);
			}

			// Start: once, any time the meeting is live (`[start, end)`), not just
			// within a short grace — so a late join or a wake mid-meeting still
			// gets a prompt. Consuming `upcoming` too keeps a 0-lead / late arrival
			// from firing a now-pointless "starts soon" afterwards.
			if (!p.started && now >= event.start && now < event.end) {
				p.upcoming = true;
				p.started = true;
				this.deps.onEventStart(event);
			}

			// End: once, at/after the end. No upper grace bound, so a boundary
			// crossed while asleep still fires on wake (the plugin decides whether
			// to auto-stop or merely offer to).
			if (!p.ended && now >= event.end) {
				p.ended = true;
				this.deps.onEventEnd(event);
			}

			this.phase.set(event.id, p);
		}
	}

	/**
	 * True when a calendar event is currently within its "already notified"
	 * window — from when the lead-time heads-up would fire through the event's
	 * end (`[start - leadMs, end)`). Lets the plugin suppress the app-detection
	 * prompt for a meeting the scheduler has already announced, so a scheduled
	 * Zoom/Meet isn't double-notified.
	 */
	hasActiveEvent(now = this.deps.now()): boolean {
		const leadMs = Math.max(0, this.deps.leadMs?.() ?? 0);
		return this.events.some(
			(e) => now >= e.start - leadMs && now < e.end
		);
	}

	start(pollIntervalMs = POLL_INTERVAL_MS, tickIntervalMs = TICK_INTERVAL_MS): void {
		if (this.pollTimer !== null) return;
		this.lastTickAt = null;
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
