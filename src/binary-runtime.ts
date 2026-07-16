import { FileSystemAdapter, requestUrl, type Plugin } from "obsidian";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { spawn as childSpawn } from "child_process";
import { Readable, Transform } from "stream";
import { pipeline } from "stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "stream/web";
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
		downloadToFile: async (url, destPath, onProgress, signal) => {
			// Electron's renderer has a streaming fetch; requestUrl would buffer
			// the whole (500 MB) model into renderer memory, so stream fetch's
			// body to a write stream instead. This is the one place fetch is
			// preferred over requestUrl, precisely because it can stream.
			// The signal aborts a stalled request (fetch has no idle timeout).
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
				// The body is still unconsumed here (pipeline hasn't taken it),
				// so cancel it before bailing.
				await res.body.cancel().catch(() => undefined);
				throw e;
			}
			const total = Number(res.headers.get("content-length") ?? 0);
			let received = 0;
			const counter = new Transform({
				transform(chunk: Buffer, _enc, cb) {
					received += chunk.length;
					onProgress?.(received, total);
					cb(null, chunk);
				},
			});
			// pipeline wires backpressure end-to-end, propagates an error from
			// ANY stage (a stalled read, a disk-full write), and destroys every
			// stream — including the fetch body via Readable.fromWeb — on
			// failure, so there's no hand-rolled drain/error/cleanup to get
			// subtly wrong.
			await pipeline(
				Readable.fromWeb(res.body as NodeWebReadableStream<Uint8Array>),
				counter,
				fs.createWriteStream(destPath),
				{ signal }
			);
		},
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
