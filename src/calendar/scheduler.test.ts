import { describe, it, expect, vi } from "vitest";
import {
	CalendarScheduler,
	POLL_LOOKBACK_MS,
	ScheduledEvent,
	SchedulerDeps,
	WAKE_GAP_MS,
} from "./scheduler";

const T = 1_000_000_000_000; // fixed base epoch ms

function evt(over: Partial<ScheduledEvent> = {}): ScheduledEvent {
	return {
		id: "e1",
		summary: "Meeting",
		start: T,
		end: T + 3_600_000,
		meetLink: null,
		location: "",
		htmlLink: "",
		attendees: [],
		organizer: null,
		iCalUID: null,
		recurringEventId: null,
		oneOnOnePartner: null,
		oneOnOnePartnerEmail: null,
		...over,
	};
}

function makeDeps(nowRef: { v: number }, events: ScheduledEvent[], over: Partial<SchedulerDeps> = {}): SchedulerDeps {
	return {
		now: () => nowRef.v,
		fetchEvents: async () => events,
		onEventStart: vi.fn(),
		onEventEnd: vi.fn(),
		...over,
	};
}

describe("CalendarScheduler", () => {
	it("fires onEventStart once when the clock crosses the start within grace", async () => {
		const now = { v: T - 1000 };
		const deps = makeDeps(now, [evt()]);
		const s = new CalendarScheduler(deps);
		await s.poll();

		s.tick(); // before start
		expect(deps.onEventStart).not.toHaveBeenCalled();

		now.v = T + 1000; // just after start
		s.tick();
		s.tick(); // second tick must not re-fire
		expect(deps.onEventStart).toHaveBeenCalledTimes(1);
		expect(deps.onEventStart).toHaveBeenCalledWith(expect.objectContaining({ id: "e1" }));
	});

	it("fires onEventEnd once when the clock crosses the end", async () => {
		const now = { v: T };
		const deps = makeDeps(now, [evt()]);
		const s = new CalendarScheduler(deps);
		await s.poll();

		now.v = T + 3_600_000 + 1000; // just after end
		s.tick();
		s.tick();
		expect(deps.onEventEnd).toHaveBeenCalledTimes(1);
	});

	it("fires onEventEnd even long after the end (wake / reload recovery)", async () => {
		// A boundary crossed while the laptop slept must still fire on the next
		// tick, so a calendar recording isn't left running for hours.
		const now = { v: T };
		const deps = makeDeps(now, [evt()]);
		const s = new CalendarScheduler(deps);
		await s.poll();

		now.v = T + 3_600_000 + 30 * 60 * 1000; // half an hour past the end
		s.tick();
		expect(deps.onEventEnd).toHaveBeenCalledTimes(1);
	});

	it("fires onEventStart for a late join while the meeting is still live", async () => {
		// Joining well past the start (beyond any short grace) but before the end
		// should still prompt — the old grace-only window dropped these.
		const now = { v: T + 15 * 60 * 1000 }; // 15 min in, event runs 60 min
		const deps = makeDeps(now, [evt()]);
		const s = new CalendarScheduler(deps);
		await s.poll();
		s.tick();
		expect(deps.onEventStart).toHaveBeenCalledTimes(1);
	});

	it("does not fire start once the meeting has already ended", async () => {
		const now = { v: T + 3_600_000 + 1000 }; // just after the end
		const deps = makeDeps(now, [evt()]);
		const s = new CalendarScheduler(deps);
		await s.poll();
		s.tick();
		expect(deps.onEventStart).not.toHaveBeenCalled();
		expect(deps.onEventEnd).toHaveBeenCalledTimes(1);
	});

	it("fires onEventUpcoming once in the lead window before the start", async () => {
		const now = { v: T - 90 * 1000 }; // 90s before start, lead is 60s
		const deps = makeDeps(now, [evt()], {
			onEventUpcoming: vi.fn(),
			leadMs: () => 60 * 1000,
		});
		const s = new CalendarScheduler(deps);
		await s.poll();

		s.tick(); // still outside the lead window
		expect(deps.onEventUpcoming).not.toHaveBeenCalled();

		now.v = T - 30 * 1000; // inside the lead window
		s.tick();
		s.tick(); // must not re-fire
		expect(deps.onEventUpcoming).toHaveBeenCalledTimes(1);
		expect(deps.onEventStart).not.toHaveBeenCalled();
	});

	it("skips the upcoming callback when the lead time is zero", async () => {
		const now = { v: T - 30 * 1000 };
		const deps = makeDeps(now, [evt()], {
			onEventUpcoming: vi.fn(),
			leadMs: () => 0,
		});
		const s = new CalendarScheduler(deps);
		await s.poll();
		now.v = T + 1000;
		s.tick();
		expect(deps.onEventUpcoming).not.toHaveBeenCalled();
		expect(deps.onEventStart).toHaveBeenCalledTimes(1);
	});

	it("does not fire a stale upcoming after a late start already fired", async () => {
		// Joining after the start (no upcoming yet) must not later replay the
		// "starts soon" prompt for the same event.
		const now = { v: T + 5 * 60 * 1000 };
		const deps = makeDeps(now, [evt()], {
			onEventUpcoming: vi.fn(),
			leadMs: () => 60 * 1000,
		});
		const s = new CalendarScheduler(deps);
		await s.poll();
		s.tick();
		expect(deps.onEventStart).toHaveBeenCalledTimes(1);
		expect(deps.onEventUpcoming).not.toHaveBeenCalled();
	});

	it("forces a re-poll when a large gap between ticks suggests sleep", async () => {
		const now = { v: T - 60 * 60 * 1000 };
		const fetchEvents = vi.fn(async () => [evt()]);
		const deps = makeDeps(now, [], { fetchEvents });
		const s = new CalendarScheduler(deps);
		await s.poll();
		expect(fetchEvents).toHaveBeenCalledTimes(1);

		s.tick(); // seeds lastTickAt
		now.v += WAKE_GAP_MS + 1000; // big jump — looks like a wake
		s.tick();
		expect(fetchEvents).toHaveBeenCalledTimes(2);
	});

	it("polls a window that reaches back far enough to recover live meetings", async () => {
		const now = { v: T };
		const fetchEvents = vi.fn(async () => []);
		const deps = makeDeps(now, [], { fetchEvents });
		const s = new CalendarScheduler(deps);
		await s.poll();
		const minMs = (fetchEvents.mock.calls[0] as unknown as number[])[0];
		expect(minMs).toBe(T - POLL_LOOKBACK_MS);
	});

	it("reports fetch errors via onError and keeps running", async () => {
		const now = { v: T };
		const onError = vi.fn();
		const deps = makeDeps(now, [], {
			fetchEvents: async () => {
				throw new Error("HTTP 401");
			},
			onError,
		});
		const s = new CalendarScheduler(deps);
		await s.poll();
		expect(onError).toHaveBeenCalledWith("HTTP 401");
	});

	it("prunes phase state for events no longer returned by a later poll", async () => {
		const now = { v: T + 1000 };
		let events = [evt()];
		const deps = makeDeps(now, [], { fetchEvents: async () => events });
		const s = new CalendarScheduler(deps);
		await s.poll();
		s.tick();
		expect(deps.onEventStart).toHaveBeenCalledTimes(1);

		// Same id returns again after being pruned; with a fresh phase it can fire again.
		events = [];
		await s.poll(); // prunes e1
		events = [evt()];
		await s.poll(); // e1 back
		now.v = T + 2000;
		s.tick();
		expect(deps.onEventStart).toHaveBeenCalledTimes(2);
	});

	describe("hasActiveEvent", () => {
		it("is false before the lead window and true from lead-time through end", async () => {
			const now = { v: T - 5 * 60 * 1000 };
			const s = new CalendarScheduler(
				makeDeps(now, [evt()], { leadMs: () => 60 * 1000 })
			);
			await s.poll();

			expect(s.hasActiveEvent()).toBe(false); // > lead before start
			now.v = T - 30 * 1000; // inside the 1-min lead window
			expect(s.hasActiveEvent()).toBe(true);
			now.v = T + 1000; // live
			expect(s.hasActiveEvent()).toBe(true);
			now.v = T + 3_600_000 - 1; // just before end
			expect(s.hasActiveEvent()).toBe(true);
			now.v = T + 3_600_000; // at end (exclusive)
			expect(s.hasActiveEvent()).toBe(false);
		});

		it("ignores the lead window when no lead is configured", async () => {
			const now = { v: T - 1000 };
			const s = new CalendarScheduler(makeDeps(now, [evt()]));
			await s.poll();

			expect(s.hasActiveEvent()).toBe(false); // just before start, no lead
			now.v = T;
			expect(s.hasActiveEvent()).toBe(true);
		});

		it("is false with no cached events", () => {
			const s = new CalendarScheduler(makeDeps({ v: T }, []));
			expect(s.hasActiveEvent()).toBe(false);
		});
	});

	it("registers both intervals via registerInterval and clears them on stop", () => {
		let seq = 0;
		const setInterval = vi.fn(() => ++seq);
		const clearInterval = vi.fn();
		vi.stubGlobal("window", { setInterval, clearInterval });
		const registerInterval = vi.fn();
		const s = new CalendarScheduler(makeDeps({ v: T }, [], { registerInterval }));
		s.start(1000, 2000);
		expect(setInterval).toHaveBeenCalledTimes(2);
		expect(registerInterval).toHaveBeenNthCalledWith(1, 1);
		expect(registerInterval).toHaveBeenNthCalledWith(2, 2);
		s.stop();
		expect(clearInterval).toHaveBeenCalledTimes(2);
		vi.unstubAllGlobals();
	});
});
