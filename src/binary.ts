/** SHA-256 (hex) of the system-recorder binary shipped with this plugin version. Refreshed per release. */
export const EXPECTED_SHA256 =
	"8a5326ea84eff8f8a3221e8584b86a2515680f6e575b7cc3e6301fa949560cf2";

const REPO = "alvarolobato/obsidian-meeting-copilot";

/** GitHub release asset URL for the system-recorder binary of the given plugin version. */
export function releaseUrl(version: string): string {
	return `https://github.com/${REPO}/releases/download/${version}/system-recorder`;
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
