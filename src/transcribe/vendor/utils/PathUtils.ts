import { normalizePath } from 'obsidian';

import type { App } from 'obsidian';

/**
 * Utility functions for dynamic path resolution
 * Replaces hardcoded config-directory paths with dynamic resolution
 */
export class PathUtils {
	private static cachedPluginDir: string | null = null;
	/**
	 * Get the plugin directory path dynamically
	 * @param app Obsidian App instance
	 * @param pluginId Plugin ID (optional, defaults to this plugin's ID)
	 * @returns Plugin directory path
	 */
	static getPluginDir(app: App, pluginId?: string): string {
			if (this.cachedPluginDir) {
				return this.cachedPluginDir;
			}

			const id = pluginId ?? PathUtils.getCurrentPluginId(); // Use manifest ID as default
			const manifestDir = this.getManifestDir(app, id);
			if (manifestDir) {
				this.cachedPluginDir = manifestDir;
				return manifestDir;
		}

		throw new Error(`Plugin manifest directory not available for plugin id: ${id}`);
	}

	/**
	 * Cache plugin directory using manifest.dir to avoid fragile configDir concatenation.
	 * Safe to call multiple times; the first non-empty value wins.
	 */
		static setPluginDir(manifestDir?: string | null): void {
			if (this.cachedPluginDir !== null || !manifestDir) {
				return;
			}
			this.cachedPluginDir = normalizePath(manifestDir);
		}

	/**
	 * Get a file path within the plugin directory
	 * @param app Obsidian App instance
	 * @param filename Filename relative to plugin directory
	 * @param pluginId Plugin ID (optional)
	 * @returns Full file path
	 */
	static getPluginFilePath(app: App, filename: string, pluginId?: string): string {
		return `${this.getPluginDir(app, pluginId)}/${filename}`;
	}

	static getPluginDirFromManifestDir(manifestDir: string): string {
		return normalizePath(manifestDir);
	}

	/**
	 * Normalize user-provided paths consistently before storage or use.
	 */
	static normalizeUserPath(path?: string | null): string {
		const trimmed = path?.trim();
		if (!trimmed) {
			return '';
		}
		return normalizePath(trimmed);
	}

	/**
	 * Get the transcription history file path
	 * @param app Obsidian App instance
	 * @returns History file path
	 */
	static getHistoryFilePath(app: App): string {
		return this.getPluginFilePath(app, 'transcription-history.json');
	}

	/**
	 * Get the user dictionary file path
	 * @param app Obsidian App instance
	 * @returns Dictionary file path
	 */
	static getUserDictionaryPath(app: App): string {
		return this.getPluginFilePath(app, 'user-dictionary.json');
	}

	/**
	 * Get WASM file path with fallback locations
	 * @param app Obsidian App instance
	 * @param filename WASM filename
	 * @param pluginId Plugin ID (optional)
	 * @returns Array of possible WASM file paths in order of preference
	 */
	static getWasmFilePaths(app: App, filename: string, pluginId?: string): string[] {
		const pluginDir = this.getPluginDir(app, pluginId);
		return this.getWasmFilePathsFromDir(pluginDir, filename, app);
	}

	static getWasmFilePathsFromDir(pluginDir: string, filename: string, app?: App): string[] {
		const base = this.getPluginDirFromManifestDir(pluginDir);
		const version = this.getPluginVersion(app);
		const candidates = [
			`${base}/node_modules/@echogarden/fvad-wasm/${filename}`,
			`${base}/${filename}`,
			`${base}/build/${filename}`,
			version ? `${base}/build/${version}/${filename}` : null
		];

		// Remove duplicates while preserving order
		const filteredCandidates = candidates.filter((candidate): candidate is string => Boolean(candidate));
		return Array.from(new Set(filteredCandidates));
	}

	private static getPluginVersion(app?: App): string | null {
			if (!app) {
				return null;
			}
			const manifest = (app as unknown as { plugins?: { manifests?: Record<string, { version?: string }> } }).plugins?.manifests?.[this.getCurrentPluginId()];
			return manifest?.version ?? null;
		}

	/**
	 * Get the plugin ID from manifest (current plugin)
	 * @returns Plugin ID
	 */
	static getCurrentPluginId(): string {
		return 'ai-transcriber';
	}

	private static getManifestDir(app: App, pluginId: string): string | null {
		const obsidianApp = app as unknown as {
			plugins?: {
					plugins?: Record<string, { manifest?: { dir?: string } }>;
					manifests?: Record<string, { dir?: string }>;
					getPlugin?: (id: string) => { manifest?: { dir?: string } } | undefined;
				};
			};

		const candidates = [
			obsidianApp.plugins?.getPlugin?.(pluginId)?.manifest?.dir,
			obsidianApp.plugins?.plugins?.[pluginId]?.manifest?.dir,
			obsidianApp.plugins?.manifests?.[pluginId]?.dir
		];

		for (const dir of candidates) {
			if (dir) {
				return normalizePath(dir);
			}
		}
		return null;
	}
}
