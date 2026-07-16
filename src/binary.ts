/** SHA-256 (hex) of the system-recorder binary shipped with this plugin version. Refreshed per release. */
export const EXPECTED_SHA256 =
	"8a5326ea84eff8f8a3221e8584b86a2515680f6e575b7cc3e6301fa949560cf2";

const REPO = "alvarolobato/obsidian-meeting-copilot";

/** GitHub release asset URL for the system-recorder binary of the given plugin version. */
export function releaseUrl(version: string): string {
	return `https://github.com/${REPO}/releases/download/${version}/system-recorder`;
}

/**
 * SHA-256 (hex) and byte size of the `whisper.framework` dylib the recorder
 * helper links for on-device transcription (issue #34). Unlike the recorder
 * binary's per-release hash, this is a CONSTANT: the dylib comes from the
 * whisper.cpp XCFramework pinned in `swift-helper/Package.swift`, so every
 * release ships the exact same bytes. The universal (x86_64+arm64) slice from
 * v1.7.5. `release.yml` asserts the shipped dylib matches this before upload —
 * if the pinned XCFramework version changes, both values must be refreshed.
 */
export const EXPECTED_WHISPER_SHA256 =
	"e6c2b3c065d06ed04ee70f3dbe7479b62ff69d71a20311b07397df8c282aeb03";
export const WHISPER_DYLIB_SIZE = 4059456;

/**
 * GitHub release asset URL for the whisper dylib of the given plugin version.
 * The plugin writes it to `whisper.framework/Versions/Current/whisper` next to
 * the helper, where the helper's `@rpath/whisper.framework/Versions/Current/whisper`
 * load command resolves it at launch.
 */
export function whisperDylibUrl(version: string): string {
	return `https://github.com/${REPO}/releases/download/${version}/whisper`;
}

/** Injected I/O so the provisioner is unit-testable with no real fs/network. */
export interface ProvisionerDeps {
	arch: () => string;
	fileExists: (path: string) => Promise<boolean>;
	readFile: (path: string) => Promise<Buffer>;
	writeFile: (path: string, data: Buffer) => Promise<void>;
	chmod: (path: string, mode: number) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
	unlink: (path: string) => Promise<void>;
	download: (url: string) => Promise<Buffer>;
	sha256: (data: Buffer) => string;
}

/**
 * Ensures a verified system-recorder binary exists at a given path, downloading
 * it from the matching GitHub release when missing or stale.
 *
 * Path resolution and real I/O live in binary-runtime.ts; this module is pure.
 * ensure() dedupes overlapping calls into one in-flight promise keyed on the
 * instance — all concurrent callers must pass the same binaryPath/version, and
 * only the first caller's onDownloadStart fires. (Single call site today.)
 */
export class BinaryProvisioner {
	private inflight: Promise<string> | null = null;

	constructor(
		private readonly deps: ProvisionerDeps,
		private readonly expectedSha: string = EXPECTED_SHA256
	) {}

	ensure(
		binaryPath: string,
		version: string,
		onDownloadStart?: () => void
	): Promise<string> {
		if (!this.inflight) {
			this.inflight = this.provision(binaryPath, version, onDownloadStart).finally(
				() => {
					this.inflight = null;
				}
			);
		}
		return this.inflight;
	}

	private async provision(
		binaryPath: string,
		version: string,
		onDownloadStart?: () => void
	): Promise<string> {
		if (this.deps.arch() !== "arm64") {
			throw new Error("System Recording requires Apple Silicon (arm64).");
		}

		if (await this.deps.fileExists(binaryPath)) {
			const existing = await this.deps.readFile(binaryPath);
			if (this.deps.sha256(existing) === this.expectedSha) {
				return binaryPath;
			}
		}

		onDownloadStart?.();

		let bytes: Buffer;
		try {
			bytes = await this.deps.download(releaseUrl(version));
		} catch (e) {
			const reason = e instanceof Error ? e.message : String(e);
			throw new Error(`Failed to download the recorder helper: ${reason}`);
		}

		if (this.deps.sha256(bytes) !== this.expectedSha) {
			throw new Error("Recorder helper failed verification.");
		}

		const tmp = `${binaryPath}.tmp`;
		try {
			await this.deps.writeFile(tmp, bytes);
			await this.deps.chmod(tmp, 0o755);
			await this.deps.rename(tmp, binaryPath);
		} catch (e) {
			try {
				await this.deps.unlink(tmp);
			} catch {
				// best-effort cleanup; ignore unlink failure
			}
			throw e;
		}
		return binaryPath;
	}
}

/**
 * Injected I/O for {@link AssetProvisioner}. Kept separate from
 * {@link ProvisionerDeps} because large model files are handled by **streaming**
 * (download straight to disk, hash from disk) rather than buffering hundreds of
 * MB in memory the way the small recorder binary can afford to.
 */
export interface AssetProvisionerDeps {
	fileExists: (path: string) => Promise<boolean>;
	/** Byte size of an existing file; the cheap "already downloaded?" probe. */
	fileSize: (path: string) => Promise<number>;
	/** SHA-256 (hex) of a file, streamed from disk so a 500 MB model isn't buffered. */
	sha256File: (path: string) => Promise<string>;
	/**
	 * Stream a URL to a destination path, reporting received/total bytes. The
	 * optional `signal` aborts both the request and the disk write so a stalled
	 * connection (no idle timeout on `fetch`) can be cancelled by the caller.
	 */
	downloadToFile: (
		url: string,
		destPath: string,
		onProgress?: (received: number, total: number) => void,
		signal?: AbortSignal
	) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
	unlink: (path: string) => Promise<void>;
}

/** Progress + lifecycle callbacks for a single {@link AssetProvisioner.ensure}. */
export interface EnsureAssetOptions {
	onDownloadStart?: () => void;
	onProgress?: (received: number, total: number) => void;
	/**
	 * Noun for this asset in error messages ("model", "recorder component", …),
	 * so a failure is attributed to the right thing. Defaults to "model".
	 */
	label?: string;
	/** Aborts an in-flight download (settings Cancel button / plugin unload). */
	signal?: AbortSignal;
}

/**
 * Ensures a large, immutable asset (a local Whisper model — issue #34) exists at
 * a path, streaming it from `url` when missing or the wrong size and verifying
 * it against a pinned SHA-256 before it's swapped into place.
 *
 * Split from {@link BinaryProvisioner} on purpose: models are big and downloaded
 * to disk (never buffered), the fast "present?" path is a size check (not a full
 * re-hash on every run — the quick-roundtrip priority of #34), and they carry no
 * Apple-Silicon gate at download time. The full SHA-256 is verified only on a
 * fresh download, off the streamed temp file, before the atomic rename.
 *
 * `ensure()` dedupes overlapping downloads of the *same* destination path into
 * one in-flight promise (keyed on the path), so a settings-tab click and an
 * about-to-transcribe call can't race two writers onto one file. As with
 * {@link BinaryProvisioner}, the first caller's `onProgress`/`onDownloadStart`
 * win — a concurrent second caller shares that in-flight download and doesn't
 * get its own callbacks (in practice only one download of a given model is ever
 * active at once).
 */
export class AssetProvisioner {
	private readonly inflight = new Map<string, Promise<string>>();

	constructor(private readonly deps: AssetProvisionerDeps) {}

	ensure(
		destPath: string,
		url: string,
		sha256: string,
		expectedSize: number,
		options?: EnsureAssetOptions
	): Promise<string> {
		const existing = this.inflight.get(destPath);
		if (existing) return existing;
		const p = this.provision(destPath, url, sha256, expectedSize, options).finally(
			() => {
				this.inflight.delete(destPath);
			}
		);
		this.inflight.set(destPath, p);
		return p;
	}

	private async provision(
		destPath: string,
		url: string,
		sha256: string,
		expectedSize: number,
		options?: EnsureAssetOptions
	): Promise<string> {
		const label = options?.label ?? "model";
		// Fast path: a present file of the exact expected size is trusted without
		// re-hashing (models are immutable and hashing 500 MB on every
		// transcription would tax the quick-roundtrip goal). A wrong size means a
		// truncated/partial download, so fall through and re-fetch. A file that
		// vanishes between the exists check and the stat (concurrent delete) also
		// falls through rather than rejecting.
		if (await this.deps.fileExists(destPath)) {
			try {
				if ((await this.deps.fileSize(destPath)) === expectedSize) {
					return destPath;
				}
			} catch {
				// stat failed (e.g. file removed mid-check) — treat as absent.
			}
		}

		options?.onDownloadStart?.();

		const tmp = `${destPath}.tmp`;
		try {
			await this.deps.downloadToFile(url, tmp, options?.onProgress, options?.signal);
		} catch (e) {
			await this.safeUnlink(tmp);
			// Preserve an abort as-is (name "AbortError") so callers can render a
			// quiet "cancelled" message instead of a scary download failure.
			if (e instanceof Error && e.name === "AbortError") throw e;
			const reason = e instanceof Error ? e.message : String(e);
			throw new Error(`Failed to download the ${label}: ${reason}`);
		}

		try {
			// A short read (network cut mid-stream) leaves a truncated temp file.
			// Catch that by size first — it's a clearer error than a hash
			// mismatch and skips hashing a file already known to be wrong.
			if ((await this.deps.fileSize(tmp)) !== expectedSize) {
				throw new Error(`The ${label} download was incomplete; please try again.`);
			}
			if ((await this.deps.sha256File(tmp)) !== sha256) {
				throw new Error(`The ${label} failed verification.`);
			}
			await this.deps.rename(tmp, destPath);
		} catch (e) {
			await this.safeUnlink(tmp);
			throw e;
		}
		return destPath;
	}

	private async safeUnlink(path: string): Promise<void> {
		try {
			await this.deps.unlink(path);
		} catch {
			// best-effort cleanup; ignore unlink failure
		}
	}
}
