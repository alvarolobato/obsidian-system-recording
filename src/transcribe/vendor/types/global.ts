/**
 * Global type definitions to reduce any casts
 * Defines types for browser APIs and Electron interfaces
 */

// Electron interfaces
export interface ElectronMain {
	safeStorage?: {
		isEncryptionAvailable: () => boolean;
		encryptString: (plainText: string) => Buffer;
		decryptString: (encrypted: Buffer) => string;
	};
}

export interface ElectronRemote {
	safeStorage?: {
		isEncryptionAvailable: () => boolean;
		encryptString: (plainText: string) => Buffer;
		decryptString: (encrypted: Buffer) => string;
	};
}

export interface ElectronRenderer {
	safeStorage?: {
		isEncryptionAvailable: () => boolean;
		encryptString: (plainText: string) => Buffer;
		decryptString: (encrypted: Buffer) => string;
	};
	remote?: ElectronRemote;
}

// Browser API extensions
export interface WakeLockSentinel {
	release: () => Promise<void>;
	type: 'screen';
	released: boolean;
	addEventListener: (type: 'release', listener: () => void) => void;
	removeEventListener: (type: 'release', listener: () => void) => void;
}

export interface WakeLockAPI {
	request: (type: 'screen') => Promise<WakeLockSentinel>;
}

// Window extensions - avoid extending Window directly to prevent circular references
export interface ElectronWindow {
	require?: (moduleName: string) => ElectronRenderer;
	webkitAudioContext?: typeof AudioContext;
}

export interface NavigatorWakeLock {
	wakeLock?: WakeLockAPI;
}

// Obsidian App interfaces (partial definitions for what we actually use)
export interface ObsidianVaultConfig {
	locale?: string;
}

export interface ObsidianVault {
	config?: ObsidianVaultConfig;
}

export interface ObsidianPlugin {
	saveSettings?: () => Promise<void>;
}

export interface ObsidianPluginCollection {
	[pluginId: string]: ObsidianPlugin;
}

export interface ObsidianPlugins {
	plugins: ObsidianPluginCollection;
}

export interface ObsidianInternalPlugin {
	getPluginById: (id: string) => unknown;
}

export interface ObsidianInternalPlugins {
	getPluginById: (id: string) => unknown;
}

export interface ObsidianApp {
	vault?: ObsidianVault;
	plugins?: ObsidianPlugins;
	internalPlugins?: ObsidianInternalPlugins;
}

// Module import types
export interface FvadWasmInstance {
	HEAP16: Int16Array;
	_malloc: (size: number) => number;
	_free: (ptr: number) => void;
	_fvad_new: () => number;
	_fvad_set_sample_rate: (instance: number, sampleRate: number) => number;
	_fvad_set_mode: (instance: number, mode: number) => number;
	_fvad_process: (instance: number, bufferPtr: number, length: number) => number;
	_fvad_free: (instance: number) => void;
}

export interface FvadModule {
	default: (options?: Record<string, unknown>) => Promise<FvadWasmInstance>;
}

// Type assertions for common casts
export const isElectronWindow = (
	win: Window
): win is Window & ElectronWindow & { require: (moduleName: string) => ElectronRenderer } => {
	return 'require' in win && typeof (win as Window & ElectronWindow).require === 'function';
};

export const isNavigatorWithWakeLock = (nav: Navigator): nav is Navigator & NavigatorWakeLock => {
	return 'wakeLock' in nav;
};
