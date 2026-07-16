/**
 * On-device transcription backend (issue #34): drives the recorder helper's
 * `transcribe` subcommand, which runs a local whisper.cpp model over Metal and
 * streams NDJSON back. This class owns the whole out-of-process contract — the
 * run manifest, the line protocol, progress mapping, and cancellation — behind
 * the shared {@link TranscriptionBackend} seam, so the orchestrator
 * ({@link ./TranscriptionService}) treats it exactly like the remote backend.
 *
 * NDJSON protocol (one JSON object per stdout line), emitted by Transcribe.swift:
 *   {"type":"progress","id":"me","percent":42}
 *   {"type":"result","id":"me","text":"…","segments":[{"start":0.0,"end":1.2,"text":"…"}]}
 *   {"type":"done"}
 *   {"type":"error","message":"…"}   (helper also exits non-zero)
 *
 * Unlike the OpenAI-compatible backend, all jobs run in ONE helper process
 * (the manifest lists them) so the model is loaded once and reused — the
 * amortized-model-load the interface calls out. The per-job early-bail hook
 * (`continueAfterJob`) is therefore a no-op here: local Whisper always emits
 * segment timestamps, so a diarized pass can never be a capability miss, and
 * the orchestrator's post-loop check covers the impossible case regardless.
 *
 * A job's `speechWindows` (the remote pre-gate that trims silence off the
 * upload, issue #67) are intentionally NOT forwarded: there's no network upload
 * to shrink on-device, and the diarized merge already drops out-of-window and
 * hallucinated segments after the fact, so correctness holds. Whole-file local
 * passes just spend some compute on silence; trimming the decode to windows is
 * a future optimization, not a correctness requirement.
 *
 * No internal serial queue (the remote backend needs one only to guard a
 * process-global endpoint seam, which this backend doesn't have). Concurrent
 * calls would each spawn their own helper — correct but Metal-contended — so
 * callers run transcriptions one at a time through the TranscriptionQueue, as
 * they already do.
 */
import type { Readable } from "stream";
import type { TFile } from "obsidian";
import type { DiarSegment } from "./diarize";
import type {
	JobResult,
	TranscribeRequest,
	TranscriptionBackend,
	ValidationResult,
} from "./backend";

/**
 * Grace period after SIGTERM before escalating to SIGKILL on cancellation, so a
 * wedged helper (stuck before whisper's abort polling begins) can't hold the
 * transcription-queue slot indefinitely.
 */
const KILL_GRACE_MS = 10_000;

/** Everything the local backend needs, resolved from settings + provisioning. */
export interface WhisperCppConfig {
	/** Absolute path to the recorder helper (hosts the `transcribe` subcommand). */
	binaryPath: string;
	/** Absolute path to the ggml model file. */
	modelPath: string;
	/** Whisper language code (e.g. "en"), or "auto" to detect. */
	language: string;
}

/**
 * The minimal child-process surface the backend uses — structurally satisfied
 * by Node's `child_process.ChildProcess`, but narrowed so the backend stays
 * unit-testable with a fake process (no real spawn).
 */
export interface WhisperChildProcess {
	stdout: Readable | null;
	stderr: Readable | null;
	on(
		event: "close",
		listener: (code: number | null, signal: string | null) => void
	): this;
	on(event: "error", listener: (err: Error) => void): this;
	// Narrowed to the two signals we send so Node's ChildProcess (whose kill
	// takes `number | Signals`) is assignable to this without pulling in the
	// `NodeJS` global (which the lint config doesn't declare).
	kill(signal?: "SIGTERM" | "SIGKILL"): boolean;
}

/** Injected I/O so the backend can be tested without a real process or fs. */
export interface WhisperCppDeps {
	spawn: (binaryPath: string, args: readonly string[]) => WhisperChildProcess;
	/** Persist the manifest JSON to a temp file; resolves to its path. */
	writeManifest: (json: string) => Promise<string>;
	/** Best-effort delete of the temp manifest once the run ends. */
	cleanup: (path: string) => Promise<void>;
	/** Absolute filesystem path for a vault file (the helper reads real paths). */
	resolveAudioPath: (file: TFile) => string;
}

interface ManifestJob {
	id: string;
	audio: string;
	segments: boolean;
}

/** A JSON string field, or the fallback when it's absent or a non-string. */
function asString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

/** Coerce one NDJSON segment object into a {@link DiarSegment}. */
function toSegment(raw: unknown): DiarSegment {
	const s = (raw ?? {}) as Record<string, unknown>;
	return {
		text: asString(s["text"]),
		// `|| 0` also normalizes a NaN from a malformed line to 0.
		start: Number(s["start"]) || 0,
		end: Number(s["end"]) || 0,
	};
}

export class WhisperCppBackend implements TranscriptionBackend {
	readonly id = "whisper-cpp" as const;

	constructor(
		private readonly config: WhisperCppConfig,
		private readonly deps: WhisperCppDeps
	) {}

	async validateConfig(): Promise<ValidationResult> {
		// Cheap + side-effect-free by contract: actual presence of the helper,
		// framework, and model is guaranteed by provisioning before construction.
		if (!this.config.binaryPath) {
			return { ok: false, message: "The recorder helper path could not be resolved." };
		}
		if (!this.config.modelPath) {
			return { ok: false, message: "No local Whisper model is selected." };
		}
		return { ok: true };
	}

	async transcribe(req: TranscribeRequest): Promise<JobResult[]> {
		if (req.jobs.length === 0) return [];
		if (req.signal?.aborted) {
			throw new DOMException("Transcription aborted", "AbortError");
		}
		const manifest = {
			model: this.config.modelPath,
			language: this.config.language || "auto",
			translate: false,
			jobs: req.jobs.map<ManifestJob>((job) => ({
				id: job.id,
				audio: this.deps.resolveAudioPath(job.file),
				segments: job.wantSegments,
			})),
		};
		const manifestPath = await this.deps.writeManifest(JSON.stringify(manifest));
		try {
			// A cancel that landed during the manifest write must not still spawn
			// the helper (the finally below removes the temp manifest).
			if (req.signal?.aborted) {
				throw new DOMException("Transcription aborted", "AbortError");
			}
			return await this.run(req, manifestPath);
		} finally {
			await this.deps.cleanup(manifestPath);
		}
	}

	/** One helper process for the whole request; resolves once it emits `done`. */
	private run(req: TranscribeRequest, manifestPath: string): Promise<JobResult[]> {
		return new Promise<JobResult[]>((resolve, reject) => {
			const t0 = Date.now();
			const n = req.jobs.length;
			if (n > 1) {
				console.warn(
					`[Meeting Copilot][transcribe] local: ${n} job(s) (${req.jobs
						.map((j) => j.id)
						.join(", ")})`
				);
			}
			const child = this.deps.spawn(this.config.binaryPath, [
				"transcribe",
				"--manifest",
				manifestPath,
			]);

			const idToIndex = new Map(req.jobs.map((job, i) => [job.id, i]));
			const results = new Map<string, JobResult>();
			let errorMessage: string | null = null;
			let sawDone = false;
			let settled = false;

			const signal = req.signal;
			// SIGTERM makes Transcribe.swift set its cancel flag and exit 130.
			// If the child ignores it (wedged before whisper's abort_callback
			// polling starts), escalate to SIGKILL after a grace period so an
			// abort can't hold the transcription-queue slot forever. `once` so a
			// second abort event can't double-kill.
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const onAbort = (): void => {
				child.kill("SIGTERM");
				killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
			};
			if (signal) signal.addEventListener("abort", onAbort, { once: true });

			const settle = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				if (killTimer) clearTimeout(killTimer);
				if (signal) signal.removeEventListener("abort", onAbort);
				fn();
			};

			const handleLine = (raw: string): void => {
				const line = raw.trim();
				if (!line) return;
				let msg: Record<string, unknown>;
				try {
					msg = JSON.parse(line) as Record<string, unknown>;
				} catch {
					// Logging is silenced helper-side, so any non-JSON line is
					// noise (a stray warning); ignore rather than fail the run.
					return;
				}
				const type = msg["type"];
				// `done` is terminal: ignore any progress/result that arrives (or
				// is flushed from the buffer) after it, so a stray trailing line
				// can't mutate the set we're about to resolve.
				if (sawDone && (type === "progress" || type === "result")) return;
				switch (type) {
					case "progress": {
						if (!req.onProgress) break;
						const idx = idToIndex.get(asString(msg["id"]));
						const pct = Number(msg["percent"]);
						if (idx === undefined || !Number.isFinite(pct)) break;
						// Slice the 0–100 bar per job, matching the shared runner:
						// job i owns [i/n, (i+1)/n]. One job fills it end to end;
						// two line up on 0–50 / 50–100.
						const base = (idx * 100) / n;
						const span = 100 / n;
						const clamped = Math.max(0, Math.min(100, pct));
						req.onProgress(base + (clamped * span) / 100);
						break;
					}
					case "result": {
						const id = asString(msg["id"]);
						const segments = Array.isArray(msg["segments"])
							? (msg["segments"] as unknown[]).map(toSegment)
							: undefined;
						results.set(id, { id, text: asString(msg["text"]), segments });
						break;
					}
					case "error":
						errorMessage = asString(msg["message"], "unknown transcription error");
						break;
					case "done":
						sawDone = true;
						break;
				}
			};

			// stdout is NDJSON; buffer across chunks and split on newlines, keeping
			// any partial trailing line for the next chunk.
			let buffer = "";
			child.stdout?.on("data", (chunk: Buffer | string) => {
				buffer += chunk.toString();
				let nl = buffer.indexOf("\n");
				while (nl >= 0) {
					handleLine(buffer.slice(0, nl));
					buffer = buffer.slice(nl + 1);
					nl = buffer.indexOf("\n");
				}
			});
			// Drain stderr so a full pipe can't stall the child, and keep a short
			// tail to enrich a non-zero-exit error message.
			let stderrTail = "";
			child.stderr?.on("data", (chunk: Buffer | string) => {
				stderrTail = (stderrTail + chunk.toString()).slice(-2000);
			});

			child.on("error", (err) =>
				settle(() =>
					reject(
						new Error(`Could not start the transcription helper: ${err.message}`)
					)
				)
			);

			child.on("close", (code, closeSignal) => {
				// Flush any final line the helper emitted without a trailing newline.
				if (buffer.trim()) handleLine(buffer);
				settle(() => {
					// A cancellation wins over the exit code so the orchestrator
					// treats it as an abort (not a transcription failure), matching
					// the remote backend's contract.
					if (signal?.aborted) {
						reject(new DOMException("Transcription aborted", "AbortError"));
						return;
					}
					if (errorMessage) {
						reject(new Error(errorMessage));
						return;
					}
					if (code !== 0) {
						const detail = stderrTail.trim() ? `: ${stderrTail.trim()}` : "";
						reject(
							new Error(
								`Transcription helper exited (code ${
									code ?? closeSignal ?? "unknown"
								})${detail}`
							)
						);
						return;
					}
					if (!sawDone) {
						reject(new Error("Transcription helper ended without completing."));
						return;
					}
					if (n > 1) {
						console.warn(
							`[Meeting Copilot][transcribe] local: done in ${(
								(Date.now() - t0) /
								1000
							).toFixed(1)}s`
						);
					}
					// The helper emits one result per job; a missing one is a
					// contract violation (a crash between jobs, a wrong id), not an
					// empty transcript — reject so the orchestrator/fallback treats
					// it as a failure rather than silently diarizing/merging a hole.
					const ordered: JobResult[] = [];
					for (const job of req.jobs) {
						const r = results.get(job.id);
						if (!r) {
							reject(
								new Error(
									`Transcription helper returned no result for job "${job.id}".`
								)
							);
							return;
						}
						ordered.push(r);
					}
					resolve(ordered);
				});
			});
		});
	}
}
