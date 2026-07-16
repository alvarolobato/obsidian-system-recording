import { beforeAll, describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import { transcribeAudio, transcribeDiarized } from "./TranscriptionService";
import {
	runJobsSequentially,
	type JobResult,
	type TranscribeRequest,
	type TranscriptionBackend,
} from "./backend";
import { initializeTranslations } from "./vendor/i18n/index";
import en from "./vendor/i18n/translations/en";
import ja from "./vendor/i18n/translations/ja";
import ko from "./vendor/i18n/translations/ko";
import zh from "./vendor/i18n/translations/zh";

// The orchestrator is now backend-agnostic: it builds jobs, drives the
// capability-miss early-bail via `continueAfterJob`, classifies each returned
// job, and merges. These tests exercise that logic against a fake backend, so
// no vendored controller / audio pipeline is needed.

beforeAll(() => {
	// isDiarizationCancelled resolves the cancelled-by-user message via t().
	initializeTranslations({ en, ja, ko, zh });
});

function fakeFile(path: string): TFile {
	const f = new TFile();
	f.path = path;
	f.name = path;
	return f;
}

/**
 * A backend that produces a canned result per job id. It delegates to the real
 * `runJobsSequentially` so the orchestrator tests exercise the production loop
 * (early-bail + abort ordering) rather than a re-implementation that could
 * drift. `ranJobs` records what actually ran.
 */
function sequentialBackend(
	resultsById: Record<string, JobResult>
): TranscriptionBackend & { ranJobs: string[]; lastRequest?: TranscribeRequest } {
	const backend = {
		id: "openai-compatible" as const,
		ranJobs: [] as string[],
		lastRequest: undefined as TranscribeRequest | undefined,
		async validateConfig() {
			return { ok: true };
		},
		async transcribe(req: TranscribeRequest): Promise<JobResult[]> {
			backend.lastRequest = req;
			return runJobsSequentially(req, async (job) => {
				backend.ranJobs.push(job.id);
				return resultsById[job.id] ?? { id: job.id, text: "" };
			});
		},
	};
	return backend;
}

function throwingBackend(error: unknown): TranscriptionBackend {
	return {
		id: "openai-compatible",
		async validateConfig() {
			return { ok: true };
		},
		async transcribe(): Promise<JobResult[]> {
			throw error;
		},
	};
}

describe("transcribeAudio", () => {
	it("runs one non-diarized job over the whole file and returns its text", async () => {
		const backend = sequentialBackend({ mixed: { id: "mixed", text: "hello world" } });
		const file = fakeFile("a.wav");
		const out = await transcribeAudio(file, backend);
		expect(out).toBe("hello world");
		const jobs = backend.lastRequest!.jobs;
		expect(jobs).toHaveLength(1);
		expect(jobs[0]!.id).toBe("mixed");
		expect(jobs[0]!.wantSegments).toBe(false);
		expect(jobs[0]!.speechWindows).toBeUndefined();
		// The exact file instance passed in is forwarded to the job.
		expect(jobs[0]!.file).toBe(file);
	});

	it("returns empty string for a legitimately empty transcript", async () => {
		// The fake returns a result for the job with empty text (silent audio).
		const backend = sequentialBackend({ mixed: { id: "mixed", text: "" } });
		expect(await transcribeAudio(fakeFile("a.wav"), backend)).toBe("");
	});

	it("throws when the backend returns NO result for the job (contract violation)", async () => {
		// A backend that returns an empty array (not a result with empty text)
		// must surface as a failure, not be coalesced into a silent "".
		const backend: TranscriptionBackend = {
			id: "openai-compatible",
			async validateConfig() {
				return { ok: true };
			},
			async transcribe() {
				return [];
			},
		};
		await expect(transcribeAudio(fakeFile("a.wav"), backend)).rejects.toThrow(/no result/i);
	});
});

describe("transcribeDiarized", () => {
	const seg = (text: string, start: number, end: number) => ({ text, start, end });

	it("merges both passes into a speaker-labelled transcript", async () => {
		const backend = sequentialBackend({
			me: { id: "me", text: "hi", segments: [seg("hi there", 0, 1)] },
			them: { id: "them", text: "yo", segments: [seg("hello back", 2, 3)] },
		});
		const result = await transcribeDiarized(fakeFile("x.me.wav"), fakeFile("x.them.wav"), backend);
		expect(result.diarized).toBe(true);
		expect(result.text).toContain("Me: hi there");
		expect(result.text).toContain("Them: hello back");
		expect(backend.ranJobs).toEqual(["me", "them"]);
	});

	it("stops after the me pass on a capability miss (skips them)", async () => {
		const backend = sequentialBackend({
			me: { id: "me", text: "real words here", segments: [] },
			them: { id: "them", text: "unused", segments: [seg("x", 0, 1)] },
		});
		const result = await transcribeDiarized(fakeFile("x.me.wav"), fakeFile("x.them.wav"), backend);
		expect(result).toEqual({ text: "", diarized: false, reason: "capability" });
		expect(backend.ranJobs).toEqual(["me"]);
	});

	it("does NOT early-bail when the me pass is silent-with-hallucination text", async () => {
		// No segments + only a stock hallucination phrase is a SILENT stream,
		// not a capability miss (issue #61): both passes must still run.
		const backend = sequentialBackend({
			me: { id: "me", text: "Thanks for watching!", segments: [] },
			them: { id: "them", text: "yo", segments: [seg("hello back", 2, 3)] },
		});
		const result = await transcribeDiarized(fakeFile("x.me.wav"), fakeFile("x.them.wav"), backend);
		expect(backend.ranJobs).toEqual(["me", "them"]);
		expect(result.diarized).toBe(true);
		expect(result.text).toContain("Them: hello back");
	});

	it("classifies a them-pass capability miss (both passes ran)", async () => {
		const backend = sequentialBackend({
			me: { id: "me", text: "hi", segments: [seg("hi", 0, 1)] },
			them: { id: "them", text: "real words here", segments: [] },
		});
		const result = await transcribeDiarized(fakeFile("x.me.wav"), fakeFile("x.them.wav"), backend);
		expect(result.reason).toBe("capability");
		expect(backend.ranJobs).toEqual(["me", "them"]);
	});

	it("treats two silent streams as a valid empty diarized result", async () => {
		const backend = sequentialBackend({
			me: { id: "me", text: "", segments: [] },
			them: { id: "them", text: "", segments: [] },
		});
		const result = await transcribeDiarized(fakeFile("x.me.wav"), fakeFile("x.them.wav"), backend);
		expect(result).toEqual({ text: "", diarized: true });
		expect(backend.ranJobs).toEqual(["me", "them"]);
	});

	it("falls back with reason 'error' on a transient failure", async () => {
		const result = await transcribeDiarized(
			fakeFile("x.me.wav"),
			fakeFile("x.them.wav"),
			throwingBackend(new Error("network blip"))
		);
		expect(result).toEqual({ text: "", diarized: false, reason: "error" });
	});

	it("re-throws a cancellation rather than swallowing it into a fallback", async () => {
		await expect(
			transcribeDiarized(
				fakeFile("x.me.wav"),
				fakeFile("x.them.wav"),
				throwingBackend(new DOMException("stopped", "AbortError"))
			)
		).rejects.toThrow();
	});

	it("pre-gates a stream only when its detector produced windows", async () => {
		const backend = sequentialBackend({
			me: { id: "me", text: "", segments: [] },
			them: { id: "them", text: "", segments: [] },
		});
		await transcribeDiarized(
			fakeFile("x.me.wav"),
			fakeFile("x.them.wav"),
			backend,
			{ me: [[0, 1]], them: [[2, 3]] },
			undefined,
			undefined,
			{ me: "vad", them: "none" }
		);
		const jobs = backend.lastRequest!.jobs;
		const me = jobs.find((j) => j.id === "me")!;
		const them = jobs.find((j) => j.id === "them")!;
		// me had VAD windows -> pre-gate with the "vad" source.
		expect(me.speechWindows).toEqual([[0, 1]]);
		expect(me.windowSource).toBe("vad");
		// them's detector heard nothing ("none") -> full pass, no pre-gate.
		expect(them.speechWindows).toBeUndefined();
		expect(them.windowSource).toBeUndefined();
	});

	it("pre-gates with the rms source when only the RMS gate had windows", async () => {
		const backend = sequentialBackend({
			me: { id: "me", text: "", segments: [] },
			them: { id: "them", text: "", segments: [] },
		});
		await transcribeDiarized(
			fakeFile("x.me.wav"),
			fakeFile("x.them.wav"),
			backend,
			{ me: [[1, 2]], them: [] },
			undefined,
			undefined,
			{ me: "rms", them: "none" }
		);
		const me = backend.lastRequest!.jobs.find((j) => j.id === "me")!;
		expect(me.speechWindows).toEqual([[1, 2]]);
		expect(me.windowSource).toBe("rms");
	});
});
