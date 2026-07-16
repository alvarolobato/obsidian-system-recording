import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import {
	runJobsSequentially,
	type JobResult,
	type TranscribeJob,
	type TranscribeRequest,
} from "./backend";

// The shared sequential job loop is the backend contract every implementation
// reuses (see OpenAICompatibleBackend.runJobs), so its ordering guarantees —
// bar slicing, abort-before-early-bail, and the continueAfterJob stop — are
// tested here once against a stubbed per-job runner.

function job(id: string): TranscribeJob {
	return { id, file: new TFile(), wantSegments: false };
}

/** A runner that reports a job-local 0/50/100 progress ramp. */
const rampRunner: Parameters<typeof runJobsSequentially>[1] = async (j, ctx) => {
	ctx.onProgress?.(0);
	ctx.onProgress?.(50);
	ctx.onProgress?.(100);
	return { id: j.id, text: j.id } as JobResult;
};

describe("runJobsSequentially", () => {
	it("fills the whole bar for a single job", async () => {
		const pct: number[] = [];
		const req: TranscribeRequest = { jobs: [job("single")], onProgress: (p) => pct.push(p) };
		await runJobsSequentially(req, rampRunner);
		expect(pct).toEqual([0, 50, 100]);
	});

	it("slices two jobs onto 0–50 and 50–100", async () => {
		const pct: number[] = [];
		const req: TranscribeRequest = { jobs: [job("me"), job("them")], onProgress: (p) => pct.push(p) };
		await runJobsSequentially(req, rampRunner);
		// me: 0,25,50 ; them: 50,75,100
		expect(pct).toEqual([0, 25, 50, 50, 75, 100]);
	});

	it("stops early when continueAfterJob returns false (skips later jobs)", async () => {
		const ran: string[] = [];
		const req: TranscribeRequest = {
			jobs: [job("me"), job("them")],
			continueAfterJob: (r) => r.id !== "me", // stop right after me
		};
		const results = await runJobsSequentially(req, async (j) => {
			ran.push(j.id);
			return { id: j.id, text: "" };
		});
		expect(ran).toEqual(["me"]);
		expect(results.map((r) => r.id)).toEqual(["me"]);
	});

	it("propagates a cancellation BEFORE consulting continueAfterJob", async () => {
		const controller = new AbortController();
		const seen: string[] = [];
		const req: TranscribeRequest = {
			jobs: [job("me"), job("them")],
			signal: controller.signal,
			// If this ran, it would stop early with reason 'capability'; the abort
			// check must win so cancellation propagates instead.
			continueAfterJob: () => {
				seen.push("continueAfterJob");
				return true;
			},
		};
		await expect(
			runJobsSequentially(req, async (j) => {
				if (j.id === "me") controller.abort(); // cancel during the me pass
				return { id: j.id, text: "" };
			})
		).rejects.toThrow(/aborted/i);
		expect(seen).toEqual([]);
	});

	it("abort wins over an early-bail request (the exact regression)", async () => {
		// The regression: cancel during me + a would-be early-bail (e.g. a
		// capability miss) must throw, NOT return early with the me result — the
		// latter would let the diarized path reclassify a cancel as a capability
		// miss and invalidate the probe.
		const controller = new AbortController();
		const req: TranscribeRequest = {
			jobs: [job("me"), job("them")],
			signal: controller.signal,
			continueAfterJob: () => false, // wants to stop after me
		};
		await expect(
			runJobsSequentially(req, async (j) => {
				if (j.id === "me") controller.abort();
				return { id: j.id, text: "" };
			})
		).rejects.toThrow(/aborted/i);
	});

	it("throws before starting a job when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const ran: string[] = [];
		await expect(
			runJobsSequentially(
				{ jobs: [job("me")], signal: controller.signal },
				async (j) => {
					ran.push(j.id);
					return { id: j.id, text: "" };
				}
			)
		).rejects.toThrow(/aborted/i);
		expect(ran).toEqual([]);
	});
});
