import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import { TFile } from "obsidian";
import {
	WhisperCppBackend,
	type WhisperCppConfig,
	type WhisperCppDeps,
	type WhisperChildProcess,
} from "./WhisperCppBackend";
import type { TranscribeJob, TranscribeRequest } from "./backend";

// A fake `child_process` the backend drives through its NDJSON contract, so the
// line protocol / progress mapping / abort / ordering can be tested without a
// real helper process.
class FakeProcess extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	kills: Array<string | undefined> = [];
	kill(signal?: string): boolean {
		this.kills.push(signal);
		return true;
	}
}

/** Flush microtasks + the setImmediate queue so stream 'data' and awaits land. */
const flush = (): Promise<void> =>
	new Promise((resolve) => setImmediate(resolve));

function job(id: string, wantSegments = false): TranscribeJob {
	const file = new TFile();
	file.path = `Recordings/${id}.wav`;
	return { id, file, wantSegments };
}

interface Harness {
	backend: WhisperCppBackend;
	proc: () => FakeProcess;
	spawned: Array<{ bin: string; args: string[] }>;
	manifests: string[];
	cleaned: string[];
}

function makeHarness(configOverride: Partial<WhisperCppConfig> = {}): Harness {
	let latest: FakeProcess | undefined;
	const spawned: Array<{ bin: string; args: string[] }> = [];
	const manifests: string[] = [];
	const cleaned: string[] = [];
	const deps: WhisperCppDeps = {
		spawn: (bin, args): WhisperChildProcess => {
			spawned.push({ bin, args: [...args] });
			latest = new FakeProcess();
			return latest;
		},
		writeManifest: async (json) => {
			manifests.push(json);
			return "/tmp/manifest.json";
		},
		cleanup: async (p) => {
			cleaned.push(p);
		},
		resolveAudioPath: (f) => `/vault/${f.path}`,
	};
	const backend = new WhisperCppBackend(
		{
			binaryPath: "/plugin/system-recorder",
			modelPath: "/models/ggml.bin",
			language: "en",
			...configOverride,
		},
		deps
	);
	return {
		backend,
		proc: () => {
			if (!latest) throw new Error("no process spawned yet");
			return latest;
		},
		spawned,
		manifests,
		cleaned,
	};
}

describe("WhisperCppBackend", () => {
	it("reports id and validates config", async () => {
		const { backend } = makeHarness();
		expect(backend.id).toBe("whisper-cpp");
		expect(await backend.validateConfig()).toEqual({ ok: true });
	});

	it("builds a manifest with absolute audio paths + segment flags and spawns transcribe", async () => {
		const h = makeHarness();
		const req: TranscribeRequest = { jobs: [job("me", true), job("them", true)] };
		const p = h.backend.transcribe(req);
		await flush();
		expect(h.spawned).toEqual([
			{ bin: "/plugin/system-recorder", args: ["transcribe", "--manifest", "/tmp/manifest.json"] },
		]);
		const manifest: unknown = JSON.parse(h.manifests[0]!);
		expect(manifest).toEqual({
			model: "/models/ggml.bin",
			language: "en",
			translate: false,
			jobs: [
				{ id: "me", audio: "/vault/Recordings/me.wav", segments: true },
				{ id: "them", audio: "/vault/Recordings/them.wav", segments: true },
			],
		});
		h.proc().stdout.write('{"type":"result","id":"me","text":"a"}\n');
		h.proc().stdout.write('{"type":"result","id":"them","text":"b"}\n');
		h.proc().stdout.write('{"type":"done"}\n');
		await flush();
		h.proc().emit("close", 0, null);
		await p;
	});

	it("returns results in job order regardless of emit order", async () => {
		const h = makeHarness();
		const p = h.backend.transcribe({ jobs: [job("me"), job("them")] });
		await flush();
		// Emit them BEFORE me; the backend must still order by req.jobs.
		h.proc().stdout.write('{"type":"result","id":"them","text":"THEM"}\n');
		h.proc().stdout.write('{"type":"result","id":"me","text":"ME"}\n');
		h.proc().stdout.write('{"type":"done"}\n');
		await flush();
		h.proc().emit("close", 0, null);
		const results = await p;
		expect(results.map((r) => r.id)).toEqual(["me", "them"]);
		expect(results.map((r) => r.text)).toEqual(["ME", "THEM"]);
	});

	it("parses segments into DiarSegments", async () => {
		const h = makeHarness();
		const p = h.backend.transcribe({ jobs: [job("me", true)] });
		await flush();
		h.proc().stdout.write(
			'{"type":"result","id":"me","text":"hello world","segments":[' +
				'{"start":0,"end":1.2,"text":"hello"},{"start":1.2,"end":2,"text":"world"}]}\n'
		);
		h.proc().stdout.write('{"type":"done"}\n');
		await flush();
		h.proc().emit("close", 0, null);
		const [result] = await p;
		expect(result!.segments).toEqual([
			{ text: "hello", start: 0, end: 1.2 },
			{ text: "world", start: 1.2, end: 2 },
		]);
	});

	it("maps a single job's progress onto the full 0–100 bar", async () => {
		const h = makeHarness();
		const pct: number[] = [];
		const p = h.backend.transcribe({ jobs: [job("single")], onProgress: (v) => pct.push(v) });
		await flush();
		for (const v of [0, 50, 100]) {
			h.proc().stdout.write(`{"type":"progress","id":"single","percent":${v}}\n`);
		}
		h.proc().stdout.write('{"type":"result","id":"single","text":"x"}\n{"type":"done"}\n');
		await flush();
		h.proc().emit("close", 0, null);
		await p;
		expect(pct).toEqual([0, 50, 100]);
	});

	it("slices two jobs' progress onto 0–50 / 50–100", async () => {
		const h = makeHarness();
		const pct: number[] = [];
		const p = h.backend.transcribe({ jobs: [job("me"), job("them")], onProgress: (v) => pct.push(v) });
		await flush();
		for (const v of [0, 50, 100]) {
			h.proc().stdout.write(`{"type":"progress","id":"me","percent":${v}}\n`);
		}
		for (const v of [0, 50, 100]) {
			h.proc().stdout.write(`{"type":"progress","id":"them","percent":${v}}\n`);
		}
		h.proc().stdout.write('{"type":"result","id":"me","text":""}\n');
		h.proc().stdout.write('{"type":"result","id":"them","text":""}\n{"type":"done"}\n');
		await flush();
		h.proc().emit("close", 0, null);
		await p;
		expect(pct).toEqual([0, 25, 50, 50, 75, 100]);
	});

	it("ignores non-JSON noise interleaved with the NDJSON stream", async () => {
		const h = makeHarness();
		const p = h.backend.transcribe({ jobs: [job("single")] });
		await flush();
		// whisper.cpp / dyld can print plain-text lines to stdout; they must be
		// skipped, not fail the run.
		h.proc().stdout.write("loading model...\n");
		h.proc().stdout.write('{"type":"result","id":"single","text":"clean"}\n');
		h.proc().stdout.write("ggml_metal_init: using Metal\n");
		h.proc().stdout.write('{"type":"done"}\n');
		await flush();
		h.proc().emit("close", 0, null);
		const [result] = await p;
		expect(result!.text).toBe("clean");
	});

	it("defaults the manifest language to 'auto' when the config language is empty", async () => {
		const h = makeHarness({ language: "" });
		const p = h.backend.transcribe({ jobs: [job("me")] });
		await flush();
		expect((JSON.parse(h.manifests[0]!) as { language: string }).language).toBe("auto");
		h.proc().stdout.write('{"type":"result","id":"me","text":"x"}\n{"type":"done"}\n');
		await flush();
		h.proc().emit("close", 0, null);
		await p;
	});

	it("reassembles an NDJSON object split across two stdout chunks", async () => {
		const h = makeHarness();
		const p = h.backend.transcribe({ jobs: [job("single")] });
		await flush();
		h.proc().stdout.write('{"type":"result","id":"sin');
		h.proc().stdout.write('gle","text":"joined"}\n{"type":"done"}\n');
		await flush();
		h.proc().emit("close", 0, null);
		const [result] = await p;
		expect(result!.text).toBe("joined");
	});

	it("flushes a final line emitted without a trailing newline", async () => {
		const h = makeHarness();
		const p = h.backend.transcribe({ jobs: [job("single")] });
		await flush();
		// No '\n' after done — the close handler must flush the buffer.
		h.proc().stdout.write('{"type":"result","id":"single","text":"tail"}\n{"type":"done"}');
		await flush();
		h.proc().emit("close", 0, null);
		const [result] = await p;
		expect(result!.text).toBe("tail");
	});

	it("rejects with the helper's error message", async () => {
		const h = makeHarness();
		const p = h.backend.transcribe({ jobs: [job("single")] });
		await flush();
		h.proc().stdout.write('{"type":"error","message":"failed to load the Whisper model"}\n');
		await flush();
		h.proc().emit("close", 1, null);
		await expect(p).rejects.toThrow("failed to load the Whisper model");
	});

	it("rejects on a non-zero exit with no error line, including stderr tail", async () => {
		const h = makeHarness();
		const p = h.backend.transcribe({ jobs: [job("single")] });
		await flush();
		h.proc().stderr.write("dyld: library not loaded\n");
		await flush();
		h.proc().emit("close", 74, null);
		await expect(p).rejects.toThrow(/code 74.*dyld: library not loaded/s);
	});

	it("rejects when a job is missing a result on the done path", async () => {
		const h = makeHarness();
		const p = h.backend.transcribe({ jobs: [job("me"), job("them")] });
		await flush();
		// Only "me" comes back; "them" is missing but the helper still said done.
		h.proc().stdout.write('{"type":"result","id":"me","text":"x"}\n{"type":"done"}\n');
		await flush();
		h.proc().emit("close", 0, null);
		await expect(p).rejects.toThrow(/no result for job "them"/);
	});

	it("ignores a stray result flushed after done", async () => {
		const h = makeHarness();
		const p = h.backend.transcribe({ jobs: [job("single")] });
		await flush();
		h.proc().stdout.write('{"type":"result","id":"single","text":"real"}\n');
		h.proc().stdout.write('{"type":"done"}\n');
		// A late duplicate (no trailing newline) flushed on close must not win.
		h.proc().stdout.write('{"type":"result","id":"single","text":"late"}');
		await flush();
		h.proc().emit("close", 0, null);
		const [result] = await p;
		expect(result!.text).toBe("real");
	});

	it("rejects when the helper ends without a done event", async () => {
		const h = makeHarness();
		const p = h.backend.transcribe({ jobs: [job("single")] });
		await flush();
		h.proc().stdout.write('{"type":"result","id":"single","text":"x"}\n');
		await flush();
		h.proc().emit("close", 0, null);
		await expect(p).rejects.toThrow(/without completing/i);
	});

	it("rejects when the process fails to start", async () => {
		const h = makeHarness();
		const p = h.backend.transcribe({ jobs: [job("single")] });
		await flush();
		h.proc().emit("error", new Error("spawn ENOENT"));
		await expect(p).rejects.toThrow(/Could not start the transcription helper.*ENOENT/);
	});

	it("throws before spawning when the signal is already aborted", async () => {
		const h = makeHarness();
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(
			h.backend.transcribe({ jobs: [job("single")], signal: ctrl.signal })
		).rejects.toThrow(/aborted/i);
		expect(h.spawned).toHaveLength(0);
	});

	it("kills the process and rejects as aborted on cancellation", async () => {
		const h = makeHarness();
		const ctrl = new AbortController();
		const p = h.backend.transcribe({ jobs: [job("single")], signal: ctrl.signal });
		await flush();
		ctrl.abort();
		expect(h.proc().kills).toContain("SIGTERM");
		// The helper exits 130 on SIGTERM; a cancellation wins over the code.
		h.proc().emit("close", 130, null);
		await expect(p).rejects.toThrow(/aborted/i);
	});

	it("cleans up the temp manifest on success and on failure", async () => {
		const ok = makeHarness();
		const p1 = ok.backend.transcribe({ jobs: [job("single")] });
		await flush();
		ok.proc().stdout.write('{"type":"result","id":"single","text":"x"}\n{"type":"done"}\n');
		await flush();
		ok.proc().emit("close", 0, null);
		await p1;
		expect(ok.cleaned).toEqual(["/tmp/manifest.json"]);

		const bad = makeHarness();
		const p2 = bad.backend.transcribe({ jobs: [job("single")] });
		await flush();
		bad.proc().emit("close", 1, null);
		await expect(p2).rejects.toThrow();
		expect(bad.cleaned).toEqual(["/tmp/manifest.json"]);
	});

	it("resolves an empty request without spawning", async () => {
		const h = makeHarness();
		expect(await h.backend.transcribe({ jobs: [] })).toEqual([]);
		expect(h.spawned).toHaveLength(0);
	});

	it("rejects with the helper's error message even when it exits 0", async () => {
		const h = makeHarness();
		const p = h.backend.transcribe({ jobs: [job("single")] });
		await flush();
		// An error line but a zero exit code: the message must win over the code.
		h.proc().stdout.write('{"type":"error","message":"model failed verification"}\n');
		await flush();
		h.proc().emit("close", 0, null);
		await expect(p).rejects.toThrow("model failed verification");
	});

	it("cleans up and never spawns when aborted between manifest write and spawn", async () => {
		const ctrl = new AbortController();
		const cleaned: string[] = [];
		const spawned: string[] = [];
		const deps: WhisperCppDeps = {
			// Abort exactly as the manifest finishes writing, so the post-write
			// re-check inside transcribe() (not the pre-write one) fires.
			spawn: (bin, args): WhisperChildProcess => {
				spawned.push(bin + " " + args.join(" "));
				return new FakeProcess();
			},
			writeManifest: async () => {
				ctrl.abort();
				return "/tmp/manifest.json";
			},
			cleanup: async (p) => {
				cleaned.push(p);
			},
			resolveAudioPath: (f) => `/vault/${f.path}`,
		};
		const backend = new WhisperCppBackend(
			{ binaryPath: "/plugin/system-recorder", modelPath: "/models/ggml.bin", language: "en" },
			deps
		);
		await expect(
			backend.transcribe({ jobs: [job("single")], signal: ctrl.signal })
		).rejects.toThrow(/aborted/i);
		expect(spawned).toHaveLength(0);
		expect(cleaned).toEqual(["/tmp/manifest.json"]);
	});

	it("escalates to SIGKILL when the helper ignores SIGTERM after an abort", async () => {
		// Fake only setTimeout/clearTimeout so flush()'s setImmediate stays real.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			const h = makeHarness();
			const ctrl = new AbortController();
			const p = h.backend.transcribe({ jobs: [job("single")], signal: ctrl.signal });
			await flush();
			ctrl.abort();
			expect(h.proc().kills).toEqual(["SIGTERM"]);
			// The helper doesn't exit; after the grace period, force-kill it.
			vi.advanceTimersByTime(10_000);
			expect(h.proc().kills).toEqual(["SIGTERM", "SIGKILL"]);
			// Let it finally close so the promise settles (abort wins).
			h.proc().emit("close", null, "SIGKILL");
			await expect(p).rejects.toThrow(/aborted/i);
		} finally {
			vi.useRealTimers();
		}
	});
});
