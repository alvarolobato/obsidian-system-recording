import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, it, expect, vi } from "vitest";
import {
	BinaryProvisioner,
	EXPECTED_FVAD_SHA256,
	EXPECTED_WHISPER_SHA256,
	FVAD_WASM_SIZE,
	fvadWasmUrl,
	ProvisionerDeps,
	releaseUrl,
	WHISPER_DYLIB_SIZE,
	whisperDylibUrl,
} from "./binary";

const VALID = "validhash";
const BIN = "/plugin/system-recorder";
const VERSION = "1.0.2";

function makeDeps(overrides: Partial<ProvisionerDeps> = {}): ProvisionerDeps {
	return {
		arch: () => "arm64",
		fileExists: async () => false,
		readFile: async () => Buffer.from("existing"),
		writeFile: async () => undefined,
		chmod: async () => undefined,
		rename: async () => undefined,
		unlink: async () => undefined,
		download: async () => Buffer.from("downloaded"),
		sha256: () => VALID,
		...overrides,
	};
}

describe("BinaryProvisioner", () => {
	it("returns the path without downloading when the existing hash matches", async () => {
		const download = vi.fn(async () => Buffer.from("x"));
		const deps = makeDeps({ fileExists: async () => true, sha256: () => VALID, download });
		await expect(new BinaryProvisioner(deps, VALID).ensure(BIN, VERSION)).resolves.toBe(BIN);
		expect(download).not.toHaveBeenCalled();
	});

	it("downloads, verifies, chmods, and renames when the binary is missing", async () => {
		const calls: string[] = [];
		const deps = makeDeps({
			fileExists: async () => false,
			download: async (url) => { calls.push(`download:${url}`); return Buffer.from("bin"); },
			sha256: () => VALID,
			writeFile: async (p) => { calls.push(`write:${p}`); },
			chmod: async (p, m) => { calls.push(`chmod:${p}:${m}`); },
			rename: async (from, to) => { calls.push(`rename:${from}->${to}`); },
		});
		await expect(new BinaryProvisioner(deps, VALID).ensure(BIN, VERSION)).resolves.toBe(BIN);
		expect(calls).toEqual([
			`download:${releaseUrl(VERSION)}`,
			`write:${BIN}.tmp`,
			`chmod:${BIN}.tmp:${0o755}`,
			`rename:${BIN}.tmp->${BIN}`,
		]);
	});

	it("re-downloads when the existing binary hash does not match", async () => {
		const download = vi.fn(async () => Buffer.from("new"));
		let n = 0;
		const deps = makeDeps({
			fileExists: async () => true,
			sha256: () => (n++ === 0 ? "old" : VALID),
			download,
		});
		await expect(new BinaryProvisioner(deps, VALID).ensure(BIN, VERSION)).resolves.toBe(BIN);
		expect(download).toHaveBeenCalledOnce();
	});

	it("throws and does not install when the download fails verification", async () => {
		const writeFile = vi.fn(async () => undefined);
		const chmod = vi.fn(async () => undefined);
		const rename = vi.fn(async () => undefined);
		const deps = makeDeps({ fileExists: async () => false, sha256: () => "wrong", writeFile, chmod, rename });
		await expect(new BinaryProvisioner(deps, VALID).ensure(BIN, VERSION)).rejects.toThrow("failed verification");
		expect(writeFile).not.toHaveBeenCalled();
		expect(chmod).not.toHaveBeenCalled();
		expect(rename).not.toHaveBeenCalled();
	});

	it("throws on non-arm64 before any fs or network access", async () => {
		const fileExists = vi.fn(async () => true);
		const download = vi.fn(async () => Buffer.from("x"));
		const deps = makeDeps({ arch: () => "x64", fileExists, download });
		await expect(new BinaryProvisioner(deps, VALID).ensure(BIN, VERSION)).rejects.toThrow("Apple Silicon");
		expect(fileExists).not.toHaveBeenCalled();
		expect(download).not.toHaveBeenCalled();
	});

	it("wraps download errors with a friendly message", async () => {
		const deps = makeDeps({
			fileExists: async () => false,
			download: async () => { throw new Error("HTTP 404"); },
		});
		await expect(new BinaryProvisioner(deps, VALID).ensure(BIN, VERSION))
			.rejects.toThrow("Failed to download the recorder helper: HTTP 404");
	});

	it("invokes onDownloadStart only when a download occurs", async () => {
		const cb = vi.fn();
		await new BinaryProvisioner(makeDeps({ fileExists: async () => true, sha256: () => VALID }), VALID)
			.ensure(BIN, VERSION, cb);
		expect(cb).not.toHaveBeenCalled();
		await new BinaryProvisioner(makeDeps({ fileExists: async () => false, sha256: () => VALID }), VALID)
			.ensure(BIN, VERSION, cb);
		expect(cb).toHaveBeenCalledOnce();
	});

	it("removes the temp file when installation fails", async () => {
		const unlink = vi.fn(async () => undefined);
		const deps = makeDeps({
			fileExists: async () => false,
			sha256: () => VALID,
			chmod: async () => { throw new Error("EACCES"); },
			unlink,
		});
		await expect(new BinaryProvisioner(deps, VALID).ensure(BIN, VERSION)).rejects.toThrow("EACCES");
		expect(unlink).toHaveBeenCalledWith(`${BIN}.tmp`);
	});

	it("dedupes concurrent ensure calls into a single download", async () => {
		let downloads = 0;
		const deps = makeDeps({
			fileExists: async () => false,
			download: async () => { downloads++; await new Promise((r) => setTimeout(r, 5)); return Buffer.from("x"); },
			sha256: () => VALID,
		});
		const p = new BinaryProvisioner(deps, VALID);
		await Promise.all([p.ensure(BIN, VERSION), p.ensure(BIN, VERSION)]);
		expect(downloads).toBe(1);
	});
});

describe("whisper dylib provisioning contract", () => {
	// release.yml pins these by regex; a reformat that breaks the shape would
	// silently ship an unverified dylib, so lock the contract here too.
	it("pins a 64-char hex SHA-256 and a positive byte size", () => {
		expect(EXPECTED_WHISPER_SHA256).toMatch(/^[0-9a-f]{64}$/);
		expect(Number.isInteger(WHISPER_DYLIB_SIZE)).toBe(true);
		expect(WHISPER_DYLIB_SIZE).toBeGreaterThan(0);
	});

	it("targets the per-version release asset named 'whisper'", () => {
		expect(whisperDylibUrl("1.2.3")).toBe(
			"https://github.com/alvarolobato/obsidian-meeting-copilot/releases/download/1.2.3/whisper"
		);
	});
});

describe("fvad.wasm provisioning contract", () => {
	it("pins a 64-char hex SHA-256 and a positive byte size", () => {
		expect(EXPECTED_FVAD_SHA256).toMatch(/^[0-9a-f]{64}$/);
		expect(Number.isInteger(FVAD_WASM_SIZE)).toBe(true);
		expect(FVAD_WASM_SIZE).toBeGreaterThan(0);
	});

	it("targets the per-version release asset named 'fvad.wasm'", () => {
		expect(fvadWasmUrl("1.2.3")).toBe(
			"https://github.com/alvarolobato/obsidian-meeting-copilot/releases/download/1.2.3/fvad.wasm"
		);
	});

	// Drift guard: fvad.wasm is an immutable npm artifact (@echogarden/fvad-wasm)
	// copied verbatim into the release, so — unlike the built+signed whisper
	// dylib — its SHA/size are pinned once here, not re-pinned per release. If a
	// dependency bump changes the bytes, this fails so the pins get updated
	// (otherwise the on-demand fetch would reject the new file as unverified).
	it("matches the fvad.wasm shipped in node_modules", () => {
		const fvadPath = fileURLToPath(
			new URL(
				"../node_modules/@echogarden/fvad-wasm/fvad.wasm",
				import.meta.url
			)
		);
		const bytes = readFileSync(fvadPath);
		expect(bytes.length).toBe(FVAD_WASM_SIZE);
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(
			EXPECTED_FVAD_SHA256
		);
	});
});
