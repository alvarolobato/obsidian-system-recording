import { FileSystemAdapter, requestUrl, type Plugin } from "obsidian";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { spawn as childSpawn } from "child_process";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { AssetProvisionerDeps, ProvisionerDeps } from "./binary";
import type { WhisperCppDeps } from "./transcribe/WhisperCppBackend";

export function nodeDeps(): ProvisionerDeps {
	return {
		arch: () => process.arch,
		fileExists: async (p) => {
			try {
				await fsp.access(p);
				return true;
			} catch {
				return false;
			}
		},
		readFile: (p) => fsp.readFile(p),
		writeFile: (p, data) => fsp.writeFile(p, data),
		chmod: (p, mode) => fsp.chmod(p, mode),
		rename: (from, to) => fsp.rename(from, to),
		unlink: (p) => fsp.unlink(p),
		download: async (url) => {
			// requestUrl follows redirects automatically (GitHub release assets 302 to a CDN);
			// res.status is the final response code.
			const res = await requestUrl({ url, method: "GET", throw: false });
			if (res.status !== 200) {
				throw new Error(`HTTP ${res.status}`);
			}
			return Buffer.from(res.arrayBuffer);
		},
		sha256: (data) => crypto.createHash("sha256").update(data).digest("hex"),
	};
}

export function resolveBinaryPath(plugin: Plugin): string {
	const adapter = plugin.app.vault.adapter;
	const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
	return path.join(basePath, plugin.manifest.dir ?? "", "system-recorder");
}

/**
 * Absolute path to `fvad.wasm` next to `main.js`, where the vendored VAD loader
 * reads it from (`<pluginDir>/fvad.wasm`). Provisioned on demand for installs
 * (e.g. BRAT) that don't ship it alongside the bundle.
 */
export function resolveFvadWasmPath(plugin: Plugin): string {
	const adapter = plugin.app.vault.adapter;
	const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
	return path.join(basePath, plugin.manifest.dir ?? "", "fvad.wasm");
}

/** Absolute path to the plugin's local-model directory (created on demand). */
export function resolveModelDir(plugin: Plugin): string {
	const adapter = plugin.app.vault.adapter;
	const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
	return path.join(basePath, plugin.manifest.dir ?? "", "models");
}

/** Absolute path to a specific local model file under {@link resolveModelDir}. */
export function resolveModelPath(plugin: Plugin, fileName: string): string {
	return path.join(resolveModelDir(plugin), fileName);
}

/**
 * Absolute path to the co-located whisper.cpp dylib the recorder helper links
 * at launch (issue #34). The helper's load command is
 * `@rpath/whisper.framework/Versions/Current/whisper`, and SwiftPM adds a
 * `@loader_path` rpath, so a real file at this path — next to the helper —
 * satisfies dyld with no symlinks needed.
 */
export function resolveWhisperDylibPath(plugin: Plugin): string {
	const adapter = plugin.app.vault.adapter;
	const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
	return path.join(
		basePath,
		plugin.manifest.dir ?? "",
		"whisper.framework",
		"Versions",
		"Current",
		"whisper"
	);
}

/**
 * True for hosts where the download ultimately serves from GitHub's release-asset
 * CDN (`release-assets.githubusercontent.com`), which sends **no** CORS headers.
 * A renderer `fetch` to such a URL is blocked with `TypeError: Failed to fetch`,
 * so those assets (today only the small ~4 MB whisper dylib) are fetched via
 * Obsidian's `requestUrl` instead — it runs in the main process, so it's both
 * CORS-exempt *and* system-proxy-aware, exactly like the helper binary download.
 * Large models live on Hugging Face (which serves CORS) and keep the streaming
 * `fetch` path so hundreds of MB never buffer in renderer memory.
 */
export function isCorslessReleaseHost(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname;
	} catch {
		return false;
	}
	return host === "github.com" || host.endsWith(".githubusercontent.com");
}

/** An abort-shaped error so callers can render a quiet "cancelled" instead of a failure. */
function abortError(): Error {
	const e = new Error("The download was aborted.");
	e.name = "AbortError";
	return e;
}

/**
 * Buffered download via Obsidian's `requestUrl` (main process): CORS-exempt and
 * proxy-aware. For small GitHub release assets only — `requestUrl` buffers the
 * whole body and can't be aborted mid-flight, so the signal is honored
 * best-effort around the (few-MB, fast) request.
 */
export async function requestUrlToFile(
	url: string,
	destPath: string,
	onProgress?: (received: number, total: number) => void,
	signal?: AbortSignal
): Promise<void> {
	if (signal?.aborted) throw abortError();
	// requestUrl follows redirects; res.status is the final response code. Accept
	// any 2xx to mirror the streaming path's `res.ok` check (GitHub returns 200).
	const res = await requestUrl({ url, method: "GET", throw: false });
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`HTTP ${res.status}`);
	}
	if (signal?.aborted) throw abortError();
	const buf = Buffer.from(res.arrayBuffer);
	await fsp.mkdir(path.dirname(destPath), { recursive: true });
	await fsp.writeFile(destPath, buf);
	onProgress?.(buf.length, buf.length);
}

/**
 * Streaming download via the renderer's `fetch` — used for large assets on hosts
 * that serve CORS (Hugging Face models), so hundreds of MB stream straight to
 * disk instead of buffering in memory. The signal aborts a stalled request
 * (fetch has no idle timeout).
 */
async function streamFetchToFile(
	url: string,
	destPath: string,
	onProgress?: (received: number, total: number) => void,
	signal?: AbortSignal
): Promise<void> {
	// eslint-disable-next-line no-restricted-globals -- requestUrl buffers the full body; a 500 MB model must stream to disk
	const res = await fetch(url, { signal });
	if (!res.ok || !res.body) {
		// Cancel the (unconsumed) body so a non-2xx can't leak a socket.
		await res.body?.cancel().catch(() => undefined);
		throw new Error(`HTTP ${res.status}`);
	}
	try {
		await fsp.mkdir(path.dirname(destPath), { recursive: true });
	} catch (e) {
		// The body is still unconsumed here, so cancel it before bailing.
		await res.body.cancel().catch(() => undefined);
		throw e;
	}
	const total = Number(res.headers.get("content-length") ?? 0);
	let received = 0;
	// Do NOT use `Readable.fromWeb(res.body)`: in Electron's renderer,
	// fetch returns a *Web* ReadableStream whose class identity differs
	// from Node's `stream/web` ReadableStream, so fromWeb's instanceof
	// check rejects it with the (baffling) 'The "readableStream" argument
	// must be an instance of ReadableStream. Received an instance of
	// ReadableStream'. Pump the reader through an async generator instead
	// — realm-agnostic, works with any WHATWG stream — and let pipeline
	// own backpressure, error propagation, the abort signal, and stream
	// teardown. Progress is counted as chunks pass through the generator.
	const reader = res.body.getReader();
	const body = Readable.from(
		(async function* () {
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) return;
					if (value && value.byteLength > 0) {
						received += value.byteLength;
						onProgress?.(received, total);
						yield value;
					}
				}
			} finally {
				// Early teardown (abort / disk-full / write error) or a
				// normal end: release the fetch body so it can't leak.
				reader.cancel().catch(() => undefined);
			}
		})(),
		{ objectMode: false }
	);
	await pipeline(body, fs.createWriteStream(destPath), { signal });
}

/**
 * Streaming I/O for {@link AssetProvisioner}: models are hundreds of MB, so the
 * download goes straight to disk and the hash is computed from the file rather
 * than buffering the whole thing in renderer memory.
 */
export function assetNodeDeps(): AssetProvisionerDeps {
	return {
		fileExists: async (p) => {
			try {
				await fsp.access(p);
				return true;
			} catch {
				return false;
			}
		},
		fileSize: async (p) => (await fsp.stat(p)).size,
		sha256File: (p) =>
			new Promise<string>((resolve, reject) => {
				const hash = crypto.createHash("sha256");
				const rs = fs.createReadStream(p);
				rs.on("error", reject);
				rs.on("data", (chunk) => hash.update(chunk));
				rs.on("end", () => resolve(hash.digest("hex")));
			}),
		// Pick the transport by host: GitHub's release-asset CDN sends no CORS
		// headers, so the renderer's fetch is blocked ("Failed to fetch"); route
		// those (small) assets through requestUrl instead. Everything else (large
		// Hugging Face models) streams via fetch. See the helpers below.
		downloadToFile: (url, destPath, onProgress, signal) =>
			isCorslessReleaseHost(url)
				? requestUrlToFile(url, destPath, onProgress, signal)
				: streamFetchToFile(url, destPath, onProgress, signal),
		rename: (from, to) => fsp.rename(from, to),
		unlink: (p) => fsp.unlink(p),
	};
}

/**
 * Real I/O for {@link WhisperCppBackend}: spawns the recorder helper's
 * `transcribe` subcommand, stages the run manifest in the OS temp dir, and maps
 * vault {@link import("obsidian").TFile} paths to the absolute filesystem paths
 * the (out-of-process) helper needs.
 */
export function whisperCppNodeDeps(plugin: Plugin): WhisperCppDeps {
	const adapter = plugin.app.vault.adapter;
	const basePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
	return {
		spawn: (binaryPath, args) => childSpawn(binaryPath, [...args]),
		writeManifest: async (json) => {
			// Unique per run (pid + time + random) so concurrent/rapid runs can't
			// clobber each other's manifest — the file is deleted once the run ends.
			const name = `mc-transcribe-${process.pid}-${Date.now()}-${Math.random()
				.toString(36)
				.slice(2)}.json`;
			const p = path.join(os.tmpdir(), name);
			await fsp.writeFile(p, json, "utf8");
			return p;
		},
		cleanup: async (p) => {
			try {
				await fsp.unlink(p);
			} catch {
				// best-effort: a missing temp manifest is fine
			}
		},
		resolveAudioPath: (file) => path.join(basePath, file.path),
	};
}
