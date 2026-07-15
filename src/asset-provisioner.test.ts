import { describe, it, expect, vi } from "vitest";
import { AssetProvisioner, AssetProvisionerDeps } from "./binary";

const SHA = "abc123";
const DEST = "/plugin/models/ggml.bin";
const URL = "https://hf.example/ggml.bin";
const SIZE = 1000;

function makeDeps(overrides: Partial<AssetProvisionerDeps> = {}): AssetProvisionerDeps {
	return {
		fileExists: async () => false,
		fileSize: async () => SIZE,
		sha256File: async () => SHA,
		downloadToFile: async () => undefined,
		rename: async () => undefined,
		unlink: async () => undefined,
		...overrides,
	};
}

describe("AssetProvisioner", () => {
	it("trusts a present file of the exact expected size without downloading", async () => {
		const downloadToFile = vi.fn(async () => undefined);
		const sha256File = vi.fn(async () => SHA);
		const deps = makeDeps({
			fileExists: async () => true,
			fileSize: async () => SIZE,
			downloadToFile,
			sha256File,
		});
		await expect(
			new AssetProvisioner(deps).ensure(DEST, URL, SHA, SIZE)
		).resolves.toBe(DEST);
		expect(downloadToFile).not.toHaveBeenCalled();
		// Fast path is a size check only — the big file is never re-hashed.
		expect(sha256File).not.toHaveBeenCalled();
	});

	it("falls through to download when the size stat throws (file vanished mid-check)", async () => {
		const downloadToFile = vi.fn(async () => undefined);
		const deps = makeDeps({
			fileExists: async () => true,
			// Only the existing dest's stat fails; the freshly downloaded temp
			// stats fine so the post-download size check passes.
			fileSize: async (p) => {
				if (p === DEST) throw new Error("ENOENT");
				return SIZE;
			},
			downloadToFile,
			sha256File: async () => SHA,
		});
		await expect(
			new AssetProvisioner(deps).ensure(DEST, URL, SHA, SIZE)
		).resolves.toBe(DEST);
		expect(downloadToFile).toHaveBeenCalledOnce();
	});

	it("re-downloads when a present file has the wrong size (partial download)", async () => {
		const downloadToFile = vi.fn(async () => undefined);
		const deps = makeDeps({
			fileExists: async () => true,
			// The stale dest is the wrong size; the re-downloaded temp is right.
			fileSize: async (p) => (p === DEST ? SIZE - 1 : SIZE),
			downloadToFile,
			sha256File: async () => SHA,
		});
		await expect(
			new AssetProvisioner(deps).ensure(DEST, URL, SHA, SIZE)
		).resolves.toBe(DEST);
		expect(downloadToFile).toHaveBeenCalledOnce();
	});

	it("downloads to a temp file, verifies the hash, then renames into place", async () => {
		const calls: string[] = [];
		const deps = makeDeps({
			fileExists: async () => false,
			downloadToFile: async (u, p) => {
				calls.push(`download:${u}->${p}`);
			},
			sha256File: async (p) => {
				calls.push(`hash:${p}`);
				return SHA;
			},
			rename: async (from, to) => {
				calls.push(`rename:${from}->${to}`);
			},
		});
		await new AssetProvisioner(deps).ensure(DEST, URL, SHA, SIZE);
		expect(calls).toEqual([
			`download:${URL}->${DEST}.tmp`,
			`hash:${DEST}.tmp`,
			`rename:${DEST}.tmp->${DEST}`,
		]);
	});

	it("rejects with an 'incomplete' error (skipping the hash) when the temp file is truncated", async () => {
		const sha256File = vi.fn(async () => SHA);
		const unlink = vi.fn(async () => undefined);
		const deps = makeDeps({
			fileExists: async () => false,
			// Post-download the temp file is the wrong (short) size.
			fileSize: async () => SIZE - 10,
			sha256File,
			unlink,
		});
		await expect(
			new AssetProvisioner(deps).ensure(DEST, URL, SHA, SIZE)
		).rejects.toThrow(/incomplete/i);
		// A known-wrong-size file is never hashed, and the temp is cleaned up.
		expect(sha256File).not.toHaveBeenCalled();
		expect(unlink).toHaveBeenCalledWith(`${DEST}.tmp`);
	});

	it("deletes the temp file and throws when the download fails verification", async () => {
		const unlink = vi.fn(async () => undefined);
		const rename = vi.fn(async () => undefined);
		const deps = makeDeps({
			fileExists: async () => false,
			sha256File: async () => "wrong-hash",
			unlink,
			rename,
		});
		await expect(
			new AssetProvisioner(deps).ensure(DEST, URL, SHA, SIZE)
		).rejects.toThrow("failed verification");
		expect(unlink).toHaveBeenCalledWith(`${DEST}.tmp`);
		expect(rename).not.toHaveBeenCalled();
	});

	it("wraps a download error with a friendly message and cleans up", async () => {
		const unlink = vi.fn(async () => undefined);
		const deps = makeDeps({
			fileExists: async () => false,
			downloadToFile: async () => {
				throw new Error("HTTP 404");
			},
			unlink,
		});
		await expect(
			new AssetProvisioner(deps).ensure(DEST, URL, SHA, SIZE)
		).rejects.toThrow("Failed to download the model: HTTP 404");
		expect(unlink).toHaveBeenCalledWith(`${DEST}.tmp`);
	});

	it("reports download progress through to the caller", async () => {
		const seen: Array<[number, number]> = [];
		const deps = makeDeps({
			fileExists: async () => false,
			downloadToFile: async (_u, _p, onProgress) => {
				onProgress?.(500, 1000);
				onProgress?.(1000, 1000);
			},
		});
		await new AssetProvisioner(deps).ensure(DEST, URL, SHA, SIZE, {
			onProgress: (received, total) => seen.push([received, total]),
		});
		expect(seen).toEqual([
			[500, 1000],
			[1000, 1000],
		]);
	});

	it("dedupes concurrent ensure calls for the same path into one download", async () => {
		let downloads = 0;
		const deps = makeDeps({
			fileExists: async () => false,
			downloadToFile: async () => {
				downloads++;
				await new Promise((r) => setTimeout(r, 5));
			},
		});
		const p = new AssetProvisioner(deps);
		await Promise.all([
			p.ensure(DEST, URL, SHA, SIZE),
			p.ensure(DEST, URL, SHA, SIZE),
		]);
		expect(downloads).toBe(1);
	});

	it("fires onDownloadStart only when a download actually happens", async () => {
		const cb = vi.fn();
		await new AssetProvisioner(
			makeDeps({ fileExists: async () => true, fileSize: async () => SIZE })
		).ensure(DEST, URL, SHA, SIZE, { onDownloadStart: cb });
		expect(cb).not.toHaveBeenCalled();
		await new AssetProvisioner(
			makeDeps({ fileExists: async () => false })
		).ensure(DEST, URL, SHA, SIZE, { onDownloadStart: cb });
		expect(cb).toHaveBeenCalledOnce();
	});
});
