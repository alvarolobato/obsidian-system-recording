import { afterEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import {
	assetNodeDeps,
	isCorslessReleaseHost,
	requestUrlToFile,
} from "./binary-runtime";
// `obsidian` is aliased to test/obsidian-mock.ts at runtime; import the test
// hook from the mock directly (the real `obsidian` types don't export it).
import { __setRequestUrl } from "../test/obsidian-mock";

// The streaming download is the highest-risk piece of the model provisioner
// (backpressure, HTTP handling, body cleanup), so exercise it against a mocked
// streaming fetch writing to a real temp file.

function streamFrom(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(chunks[i++]);
			} else {
				controller.close();
			}
		},
		cancel() {
			onCancel?.();
		},
	});
}

// A body that implements ONLY the WHATWG reader API (`getReader`) and is NOT a
// Node `stream/web` ReadableStream — exactly what Electron's renderer `fetch`
// returns. This shape broke the original `Readable.fromWeb(res.body)` with the
// baffling 'must be an instance of ReadableStream. Received an instance of
// ReadableStream' (two different ReadableStream classes across realms). The
// generator-based pump must accept it. Regressing to fromWeb fails this test.
function foreignReaderBody(chunks: Uint8Array[], onCancel?: () => void): ReadableStream<Uint8Array> {
	let i = 0;
	return {
		getReader() {
			return {
				read: async () =>
					i < chunks.length
						? { done: false, value: chunks[i++] }
						: { done: true, value: undefined },
				cancel: async () => {
					onCancel?.();
				},
			};
		},
	} as unknown as ReadableStream<Uint8Array>;
}

function fakeResponse(opts: {
	ok: boolean;
	status: number;
	body: ReadableStream<Uint8Array> | null;
	contentLength?: number;
}): Response {
	return {
		ok: opts.ok,
		status: opts.status,
		body: opts.body,
		headers: {
			get: (k: string) =>
				k.toLowerCase() === "content-length" && opts.contentLength !== undefined
					? String(opts.contentLength)
					: null,
		},
	} as unknown as Response;
}

async function tmpPath(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-dl-"));
	return path.join(dir, "sub", "model.bin");
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("assetNodeDeps().downloadToFile", () => {
	it("streams the body to disk, creating parent dirs, and reports progress", async () => {
		const chunks = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				fakeResponse({ ok: true, status: 200, body: streamFrom(chunks), contentLength: 5 })
			)
		);
		const dest = await tmpPath();
		const seen: Array<[number, number]> = [];
		await assetNodeDeps().downloadToFile("https://x/model.bin", dest, (r, t) =>
			seen.push([r, t])
		);
		const written = await fs.readFile(dest);
		expect([...written]).toEqual([1, 2, 3, 4, 5]);
		expect(seen).toEqual([
			[3, 5],
			[5, 5],
		]);
	});

	it("streams a foreign Web ReadableStream body (the Electron fetch case)", async () => {
		let cancelled = false;
		const chunks = [new Uint8Array([7, 8]), new Uint8Array([9])];
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				fakeResponse({
					ok: true,
					status: 200,
					body: foreignReaderBody(chunks, () => {
						cancelled = true;
					}),
					contentLength: 3,
				})
			)
		);
		const dest = await tmpPath();
		const seen: Array<[number, number]> = [];
		await assetNodeDeps().downloadToFile("https://x/model.bin", dest, (r, t) =>
			seen.push([r, t])
		);
		const written = await fs.readFile(dest);
		expect([...written]).toEqual([7, 8, 9]);
		expect(seen).toEqual([
			[2, 3],
			[3, 3],
		]);
		// The generator's finally releases the body even on a clean finish.
		expect(cancelled).toBe(true);
	});

	it("reports total 0 when Content-Length is absent (HF CDN redirect)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				fakeResponse({ ok: true, status: 200, body: streamFrom([new Uint8Array([9])]) })
			)
		);
		const dest = await tmpPath();
		const seen: Array<[number, number]> = [];
		await assetNodeDeps().downloadToFile("https://x/model.bin", dest, (r, t) =>
			seen.push([r, t])
		);
		expect(seen).toEqual([[1, 0]]);
	});

	it("rejects when the destination can't be written (write-stream error propagates)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				fakeResponse({
					ok: true,
					status: 200,
					body: streamFrom([new Uint8Array([1, 2, 3])]),
					contentLength: 3,
				})
			)
		);
		// Point the destination at a directory: createWriteStream fails, and the
		// pipeline must surface that as a rejection rather than hang.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-dl-"));
		await expect(
			assetNodeDeps().downloadToFile("https://x/model.bin", dir)
		).rejects.toBeTruthy();
	});

	it("throws HTTP <status> and cancels the body on a non-2xx response", async () => {
		let cancelled = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				fakeResponse({
					ok: false,
					status: 404,
					body: streamFrom([new Uint8Array([1])], () => {
						cancelled = true;
					}),
				})
			)
		);
		const dest = await tmpPath();
		await expect(
			assetNodeDeps().downloadToFile("https://x/model.bin", dest)
		).rejects.toThrow("HTTP 404");
		expect(cancelled).toBe(true);
		// Nothing should have been written for a rejected response.
		await expect(fs.readFile(dest)).rejects.toBeTruthy();
	});
});

describe("isCorslessReleaseHost", () => {
	it("is true for GitHub release URLs (no CORS on the asset CDN)", () => {
		expect(
			isCorslessReleaseHost(
				"https://github.com/owner/repo/releases/download/0.4.3/whisper"
			)
		).toBe(true);
	});

	it("is true for *.githubusercontent.com (the redirect target)", () => {
		expect(
			isCorslessReleaseHost(
				"https://release-assets.githubusercontent.com/x/y"
			)
		).toBe(true);
		expect(
			isCorslessReleaseHost("https://objects.githubusercontent.com/z")
		).toBe(true);
	});

	it("is false for Hugging Face (serves CORS, streamed via fetch)", () => {
		expect(
			isCorslessReleaseHost(
				"https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin"
			)
		).toBe(false);
	});

	it("is false for a non-github lookalike host", () => {
		// endsWith guards against a spoof like `evilgithubusercontent.com`.
		expect(isCorslessReleaseHost("https://notgithub.com/x")).toBe(false);
		expect(
			isCorslessReleaseHost("https://evilgithubusercontent.com/x")
		).toBe(false);
	});

	it("is false for an unparseable URL", () => {
		expect(isCorslessReleaseHost("not a url")).toBe(false);
		expect(isCorslessReleaseHost("")).toBe(false);
	});
});

describe("requestUrlToFile (GitHub assets, CORS-exempt via requestUrl)", () => {
	const tmpDirs: string[] = [];

	afterEach(async () => {
		__setRequestUrl(() => ({ status: 200, json: {}, text: "" }));
		await Promise.all(
			tmpDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }))
		);
	});

	async function freshDest(): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mc-dylib-"));
		tmpDirs.push(dir);
		// Nested to prove mkdir -p of the whisper.framework layout.
		return path.join(
			dir,
			"whisper.framework",
			"Versions",
			"Current",
			"whisper"
		);
	}

	it("writes the fetched bytes to a nested destination and reports progress", async () => {
		const payload = new TextEncoder().encode("dylib-bytes");
		__setRequestUrl(() => ({ status: 200, arrayBuffer: payload.buffer }));
		const dest = await freshDest();
		const progress: Array<[number, number]> = [];

		await requestUrlToFile(
			"https://github.com/o/r/releases/download/1/whisper",
			dest,
			(r, t) => progress.push([r, t])
		);

		expect(await fs.readFile(dest, "utf8")).toBe("dylib-bytes");
		expect(progress).toEqual([[payload.byteLength, payload.byteLength]]);
	});

	it("throws HTTP <status> on a non-2xx response", async () => {
		__setRequestUrl(() => ({ status: 404, text: "nope" }));
		const dest = await freshDest();
		await expect(
			requestUrlToFile(
				"https://github.com/o/r/releases/download/1/whisper",
				dest
			)
		).rejects.toThrow("HTTP 404");
		// Nothing written for a rejected response (throws before writeFile).
		await expect(fs.readFile(dest)).rejects.toBeTruthy();
	});

	it("routes GitHub URLs through requestUrl (never fetch) end-to-end", async () => {
		const payload = new TextEncoder().encode("gh-bytes");
		__setRequestUrl(() => ({ status: 200, arrayBuffer: payload.buffer }));
		const fetchSpy = vi.fn(async () => {
			throw new Error("fetch must not be called for GitHub assets");
		});
		vi.stubGlobal("fetch", fetchSpy);
		const dest = await freshDest();

		await assetNodeDeps().downloadToFile(
			"https://github.com/o/r/releases/download/1/whisper",
			dest
		);

		expect(await fs.readFile(dest, "utf8")).toBe("gh-bytes");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects with an AbortError when the signal is already aborted", async () => {
		const ac = new AbortController();
		ac.abort();
		const dest = await freshDest();
		await expect(
			requestUrlToFile(
				"https://github.com/o/r/releases/download/1/whisper",
				dest,
				undefined,
				ac.signal
			)
		).rejects.toHaveProperty("name", "AbortError");
	});
});
