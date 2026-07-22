import { describe, expect, it, vi } from "vitest";
import { awaitIndexedFile, type IndexedFileDeps } from "./awaitIndexedFile";
import { findByPathCaseInsensitive } from "./caseInsensitivePath";

/** A manual timer scheduler so poll/cap behavior is deterministic in tests. */
function makeClock() {
	let seq = 1;
	const timers = new Map<number, { fn: () => void; ms: number }>();
	return {
		setTimeout: (fn: () => void, ms: number): number => {
			const id = seq++;
			timers.set(id, { fn, ms });
			return id;
		},
		clearTimeout: (id: number): void => {
			timers.delete(id);
		},
		/** Fire (and drop) every currently-scheduled timer whose delay === ms. */
		fireByMs(ms: number): void {
			const due = [...timers.entries()].filter(([, t]) => t.ms === ms);
			for (const [id] of due) timers.delete(id);
			for (const [, t] of due) t.fn();
		},
		count: (): number => timers.size,
	};
}

/** Let the async `existsOnDisk` await + Promise executor run. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("awaitIndexedFile", () => {
	it("returns the file immediately when already indexed (no disk check)", async () => {
		const unsub = vi.fn();
		const deps: IndexedFileDeps<string> = {
			getIndexed: () => "FILE",
			existsOnDisk: async () => {
				throw new Error("disk should not be checked on an immediate hit");
			},
			onCreate: () => unsub,
			setTimeout: () => 0,
			clearTimeout: () => undefined,
		};
		await expect(awaitIndexedFile("p", deps)).resolves.toBe("FILE");
		expect(unsub).not.toHaveBeenCalled();
	});

	it("resolves null without waiting when the file is not on disk", async () => {
		const clock = makeClock();
		const unsub = vi.fn();
		const res = await awaitIndexedFile<string>("p", {
			getIndexed: () => null,
			existsOnDisk: async () => false,
			onCreate: () => unsub,
			setTimeout: clock.setTimeout,
			clearTimeout: clock.clearTimeout,
		});
		expect(res).toBeNull();
		expect(clock.count()).toBe(0);
		expect(unsub).not.toHaveBeenCalled();
	});

	it("resolves via the create event once the file is indexed", async () => {
		const clock = makeClock();
		let indexed: string | null = null;
		let cb: ((p: string) => void) | null = null;
		const unsub = vi.fn();
		const p = awaitIndexedFile<string>(
			"p",
			{
				getIndexed: () => indexed,
				existsOnDisk: async () => true,
				onCreate: (fn) => {
					cb = fn;
					return unsub;
				},
				setTimeout: clock.setTimeout,
				clearTimeout: clock.clearTimeout,
			},
			{ capMs: 9_999, pollMs: 9_999 }
		);
		await tick();
		expect(cb).toBeTypeOf("function");
		// A create for a different path must not resolve.
		cb!("other");
		indexed = "FILE";
		cb!("p");
		await expect(p).resolves.toBe("FILE");
		expect(unsub).toHaveBeenCalledTimes(1);
		expect(clock.count()).toBe(0); // poll + cap timers cleared on finish
	});

	it("resolves via the poll backstop when no create event arrives", async () => {
		const clock = makeClock();
		let indexed: string | null = null;
		const unsub = vi.fn();
		const p = awaitIndexedFile<string>(
			"p",
			{
				getIndexed: () => indexed,
				existsOnDisk: async () => true,
				onCreate: () => unsub,
				setTimeout: clock.setTimeout,
				clearTimeout: clock.clearTimeout,
			},
			{ capMs: 100_000, pollMs: 500 }
		);
		await tick();
		clock.fireByMs(500); // first poll: still null → reschedules
		indexed = "FILE";
		clock.fireByMs(500); // second poll: finds it
		await expect(p).resolves.toBe("FILE");
		expect(unsub).toHaveBeenCalledTimes(1);
		expect(clock.count()).toBe(0);
	});

	it("resolves null at the cap when the file is never indexed", async () => {
		const clock = makeClock();
		const unsub = vi.fn();
		const p = awaitIndexedFile<string>(
			"p",
			{
				getIndexed: () => null,
				existsOnDisk: async () => true,
				onCreate: () => unsub,
				setTimeout: clock.setTimeout,
				clearTimeout: clock.clearTimeout,
			},
			{ capMs: 1_000, pollMs: 100_000 }
		);
		await tick();
		clock.fireByMs(1_000); // cap fires
		await expect(p).resolves.toBeNull();
		expect(unsub).toHaveBeenCalledTimes(1);
		expect(clock.count()).toBe(0);
	});

	it("resolves null and cleans up when aborted mid-wait", async () => {
		const clock = makeClock();
		const unsub = vi.fn();
		const ac = new AbortController();
		const p = awaitIndexedFile<string>(
			"p",
			{
				getIndexed: () => null,
				existsOnDisk: async () => true,
				onCreate: () => unsub,
				setTimeout: clock.setTimeout,
				clearTimeout: clock.clearTimeout,
			},
			{ capMs: 100_000, pollMs: 100_000, signal: ac.signal }
		);
		await tick();
		ac.abort();
		await expect(p).resolves.toBeNull();
		expect(unsub).toHaveBeenCalledTimes(1);
		expect(clock.count()).toBe(0);
	});

	it("ignores an abort that arrives after the wait already resolved", async () => {
		const clock = makeClock();
		let indexed: string | null = null;
		let cb: ((p: string) => void) | null = null;
		const unsub = vi.fn();
		const ac = new AbortController();
		const p = awaitIndexedFile<string>(
			"p",
			{
				getIndexed: () => indexed,
				existsOnDisk: async () => true,
				onCreate: (fn) => {
					cb = fn;
					return unsub;
				},
				setTimeout: clock.setTimeout,
				clearTimeout: clock.clearTimeout,
			},
			{ capMs: 100_000, pollMs: 100_000, signal: ac.signal }
		);
		await tick();
		indexed = "FILE";
		cb!("p"); // resolves with the file
		await expect(p).resolves.toBe("FILE");
		// A late abort must not flip the already-settled result or re-run cleanup.
		ac.abort();
		expect(unsub).toHaveBeenCalledTimes(1);
		expect(clock.count()).toBe(0);
	});

	it("returns null immediately when the signal is already aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		const res = await awaitIndexedFile<string>(
			"p",
			{
				getIndexed: () => null,
				existsOnDisk: async () => {
					throw new Error("no disk check when pre-aborted");
				},
				onCreate: () => () => undefined,
				setTimeout: () => 0,
				clearTimeout: () => undefined,
			},
			{ signal: ac.signal }
		);
		expect(res).toBeNull();
	});

	it("resolves a case-desynced path via a case-insensitive getIndexed + poll", async () => {
		// Mirrors resolveIndexedRecording's wiring: auto-transcribe waits on the
		// settings-cased path, but the vault indexed the folder under a different
		// case (macOS case-insensitive FS). The create event still fires with the
		// *indexed* (lowercase) path, so the exact `createdPath === path` filter
		// won't wake — the poll backstop + case-insensitive getIndexed must.
		const clock = makeClock();
		const waited = "Meetings/x.m4a"; // settings-derived path
		const indexed = "meetings/x.m4a"; // how the vault indexed it
		let files: { path: string }[] = [];
		let cb: ((p: string) => void) | null = null;
		const unsub = vi.fn();
		const p = awaitIndexedFile<{ path: string }>(
			waited,
			{
				getIndexed: (path) =>
					files.find((f) => f.path === path) ??
					findByPathCaseInsensitive(files, path),
				existsOnDisk: async () => true, // on disk under either case
				onCreate: (fn) => {
					cb = fn;
					return unsub;
				},
				setTimeout: clock.setTimeout,
				clearTimeout: clock.clearTimeout,
			},
			{ capMs: 100_000, pollMs: 500 }
		);
		await tick();
		files = [{ path: indexed }];
		cb!(indexed); // exact-case create filter ignores the lowercase path
		await tick();
		clock.fireByMs(500); // poll finds it case-insensitively
		await expect(p).resolves.toEqual({ path: indexed });
		expect(unsub).toHaveBeenCalledTimes(1);
		expect(clock.count()).toBe(0);
	});

	it("resolves via the post-subscribe re-check (indexed during the disk await)", async () => {
		const clock = makeClock();
		let calls = 0;
		const unsub = vi.fn();
		const p = awaitIndexedFile<string>(
			"p",
			{
				// null on the immediate check, then the file once we're subscribed.
				getIndexed: () => (++calls >= 2 ? "FILE" : null),
				existsOnDisk: async () => true,
				onCreate: () => unsub,
				setTimeout: clock.setTimeout,
				clearTimeout: clock.clearTimeout,
			},
			{ capMs: 100_000, pollMs: 100_000 }
		);
		await expect(p).resolves.toBe("FILE");
		expect(unsub).toHaveBeenCalledTimes(1);
		expect(clock.count()).toBe(0);
	});
});
