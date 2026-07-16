import { afterEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { assetNodeDeps } from "./binary-runtime";

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
