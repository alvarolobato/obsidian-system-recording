import { describe, it, expect, vi } from "vitest";
import { CalendarScheduler, GRACE_MS, ScheduledEvent, SchedulerDeps } from "./scheduler";

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

	it("fires onEventEnd once when the clock crosses the end within grace", async () => {
		const now = { v: T };
		const deps = makeDeps(now, [evt()]);
		const s = new CalendarScheduler(deps);
		await s.poll();

		now.v = T + 3_600_000 + 1000; // just after end
		s.tick();
		s.tick();
		expect(deps.onEventEnd).toHaveBeenCalledTimes(1);
	});

	it("does not fire start when the boundary is older than the grace window", async () => {
		const now = { v: T + GRACE_MS + 5000 };
		const deps = makeDeps(now, [evt()]);
		const s = new CalendarScheduler(deps);
		await s.poll();
		s.tick();
		expect(deps.onEventStart).not.toHaveBeenCalled();
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
