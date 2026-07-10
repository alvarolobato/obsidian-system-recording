/**
 * Global resource manager for handling AudioContext, AbortController, and other resources
 * Ensures proper cleanup and prevents memory leaks
 */

import { Logger } from '../../utils/Logger';

interface WindowWithWebKit extends Window {
	webkitAudioContext?: typeof AudioContext;
}

export interface ResourceConfig {
	id: string;
	type: 'audio-context' | 'abort-controller' | 'other';
	metadata?: Record<string, unknown>;
}

export class ResourceManager {
	private static instance: ResourceManager | null = null;
	private audioContexts: Map<string, AudioContext> = new Map();
	private abortControllers: Map<string, AbortController> = new Map();
	private cleanupHandlers: Map<string, Array<() => void | Promise<void>>> = new Map();
	private resourceMetadata: Map<string, ResourceConfig> = new Map();
	private logger = Logger.getLogger('ResourceManager');

	// Private constructor for singleton pattern
	private constructor() {
		this.logger.debug('ResourceManager singleton created');
	}

	/**
	 * Get singleton instance
	 */
	static getInstance(): ResourceManager {
		ResourceManager.instance ??= new ResourceManager();
		return ResourceManager.instance;
	}

	/**
	 * Get or create an AudioContext
	 */
	getAudioContext(id: string, config?: AudioContextOptions): Promise<AudioContext> {
		// Check for existing context
		if (this.audioContexts.has(id)) {
			const existing = this.audioContexts.get(id);
			if (existing && existing.state !== 'closed') {
				return Promise.resolve(existing);
			}
			// Remove closed context
			this.audioContexts.delete(id);
			}

			// Create new context
			const AudioContextConstructor = (window as WindowWithWebKit).webkitAudioContext ?? window.AudioContext;
			const context = new AudioContextConstructor(config);
			this.audioContexts.set(id, context);

		// Store metadata
		this.resourceMetadata.set(id, {
			id,
			type: 'audio-context',
			metadata: { created: new Date().toISOString(), config }
		});

		return Promise.resolve(context);
	}

	/**
	 * Close and remove an AudioContext
	 */
	async closeAudioContext(id: string): Promise<void> {
		const context = this.audioContexts.get(id);
		if (context && context.state !== 'closed') {
			try {
				await context.close();
			} catch (error) {
				this.logger.error(`Error closing AudioContext ${id}`, error);
			}
		}
		this.audioContexts.delete(id);
		this.resourceMetadata.delete(id);
	}

	/**
	 * Get or create an AbortController
	 */
	getAbortController(id: string): AbortController {
		// Clean up any existing controller with this ID
		this.cleanupAbortController(id);

		// Create new controller
		const controller = new AbortController();
		this.abortControllers.set(id, controller);

		// Store metadata
		this.resourceMetadata.set(id, {
			id,
			type: 'abort-controller',
			metadata: { created: new Date().toISOString() }
		});

		return controller;
	}

	/**
	 * Clean up an AbortController and its associated handlers
	 */
	cleanupAbortController(id: string): void {
		const controller = this.abortControllers.get(id);
			if (controller) {

				// Execute cleanup handlers
				const handlers = this.cleanupHandlers.get(id) ?? [];
				for (const handler of handlers) {
					try {
						const result = handler();
						if (result instanceof Promise) {
						// Handle async cleanup without blocking
						result.catch(error => {
							this.logger.error(`Error in async cleanup handler for ${id}`, error);
						});
					}
				} catch (error) {
					this.logger.error(`Error in cleanup handler for ${id}`, error);
				}
			}

			// Remove from maps
			this.cleanupHandlers.delete(id);
			this.abortControllers.delete(id);
			this.resourceMetadata.delete(id);
		}
	}

	/**
	 * Register a cleanup handler for a resource
	 */
	registerCleanupHandler(id: string, handler: () => void | Promise<void>): void {
		if (!this.cleanupHandlers.has(id)) {
			this.cleanupHandlers.set(id, []);
		}
		const handlers = this.cleanupHandlers.get(id);
		if (handlers) {
			handlers.push(handler);
		}
	}

	/**
	 * Check if a resource exists
	 */
	hasResource(id: string): boolean {
		return this.audioContexts.has(id) || this.abortControllers.has(id);
	}

	/**
	 * Get resource metadata
	 */
	getResourceInfo(id: string): ResourceConfig | undefined {
		return this.resourceMetadata.get(id);
	}

	/**
	 * Get all active resources
	 */
	getActiveResources(): ResourceConfig[] {
		return Array.from(this.resourceMetadata.values());
	}

	/**
	 * Clean up all resources
	 */
	async cleanupAll(): Promise<void> {

		// Close all AudioContexts
		const audioContextPromises: Promise<void>[] = [];
		for (const [id, context] of this.audioContexts) {
			if (context.state !== 'closed') {
				audioContextPromises.push(this.closeAudioContext(id));
			}
		}

		// Wait for all audio contexts to close
		if (audioContextPromises.length > 0) {
			await Promise.all(audioContextPromises);
		}

		// Clean up all AbortControllers
		const controllerIds = Array.from(this.abortControllers.keys());
		for (const id of controllerIds) {
			this.cleanupAbortController(id);
		}

		// Clear all maps
		this.audioContexts.clear();
		this.abortControllers.clear();
		this.cleanupHandlers.clear();
		this.resourceMetadata.clear();

	}

	/**
	 * Get statistics about resource usage
	 */
	getStatistics(): {
		audioContexts: number;
		abortControllers: number;
		cleanupHandlers: number;
		totalResources: number;
		} {
		return {
			audioContexts: this.audioContexts.size,
			abortControllers: this.abortControllers.size,
			cleanupHandlers: this.cleanupHandlers.size,
			totalResources: this.resourceMetadata.size
		};
	}
}
