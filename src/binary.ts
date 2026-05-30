export const EXPECTED_SHA256 =
	"8a5326ea84eff8f8a3221e8584b86a2515680f6e575b7cc3e6301fa949560cf2";

const REPO = "yut0takagi/obsidian-system-recording";

export function releaseUrl(version: string): string {
	return `https://github.com/${REPO}/releases/download/${version}/system-recorder`;
}

export interface ProvisionerDeps {
	arch: () => string;
	fileExists: (path: string) => Promise<boolean>;
	readFile: (path: string) => Promise<Buffer>;
	writeFile: (path: string, data: Buffer) => Promise<void>;
	chmod: (path: string, mode: number) => Promise<void>;
	rename: (from: string, to: string) => Promise<void>;
	download: (url: string) => Promise<Buffer>;
	sha256: (data: Buffer) => string;
}

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
			throw new Error(
				`Failed to download the recorder helper: ${(e as Error).message}`
			);
		}

		if (this.deps.sha256(bytes) !== this.expectedSha) {
			throw new Error("Recorder helper failed verification.");
		}

		const tmp = `${binaryPath}.tmp`;
		await this.deps.writeFile(tmp, bytes);
		await this.deps.chmod(tmp, 0o755);
		await this.deps.rename(tmp, binaryPath);
		return binaryPath;
	}
}
