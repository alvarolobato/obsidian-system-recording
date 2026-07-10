/**
 * VAD-based chunking service implementation
 * Uses WebRTC VAD to create chunks at natural speech boundaries
 */

import { Notice } from 'obsidian';

import { ChunkingService } from '../../core/chunking/ChunkingService';
import { t } from '../../i18n';
import { VADChunkingProcessor } from '../../vad/processors/VadChunkingProcessor';


import type { ProcessedAudio, AudioChunk } from '../../core/audio/AudioTypes';
import type { ChunkStrategy, ChunkingConfig } from '../../core/chunking/ChunkingTypes';
import type { VADConfig } from '../../vad/VadTypes';
import type { App } from 'obsidian';

export class VADChunkingService extends ChunkingService {
	private vadProcessor: VADChunkingProcessor | null = null;
	private app: App;
	private vadConfig: VADConfig;
	private pluginId?: string;
	private initialized = false;

	constructor(
		app: App,
		config: ChunkingConfig,
		vadConfig: VADConfig,
		pluginId?: string
		) {
			super(config);
			this.app = app;
			this.vadConfig = vadConfig;
			if (pluginId !== undefined) {
				this.pluginId = pluginId;
			}
		}

	/**
	 * Initialize VAD processor
	 */
	private async ensureInitialized(): Promise<void> {
		if (this.initialized && this.vadProcessor) {
			return;
		}

		this.vadProcessor = new VADChunkingProcessor(
			this.app,
			this.vadConfig,
			this.config,
			this.pluginId
		);

		try {
			await this.vadProcessor.initialize();
			this.initialized = true;
		} catch (error) {
			this.logger.error('Failed to initialize VAD processor', error);

			// Check if the error is related to missing fvad.wasm
			if (error instanceof Error && error.message.includes('WASM file not found')) {
				new Notice(
					t('notices.vadInitError'),
					5000
				);
			}

			// Re-throw the error to let the caller handle it
			throw error;
		}
	}

	/**
	 * Calculate chunking strategy based on audio properties
	 * Override to always require chunking for VAD processing
	 */
	override calculateStrategy(audio: ProcessedAudio): ChunkStrategy {
		const totalDuration = audio.duration;
		const estimatedSizeMB = this.estimateSize(audio);


		// For VAD-based chunking, we always process through VAD
		// Even if the audio is short, VAD can improve quality by removing silence
		const needsChunking = totalDuration > this.config.constraints.chunkDurationSeconds ||
							  estimatedSizeMB > this.config.constraints.maxSizeMB * 0.9;

		if (!needsChunking && totalDuration <= this.config.constraints.chunkDurationSeconds) {
			// Single chunk, but still processed through VAD
			return {
				needsChunking: false,
				totalChunks: 1,
				chunkDuration: totalDuration,
				overlapDuration: 0,
				totalDuration
			};
		}

		// Estimate chunks based on preferred duration
		const effectiveDuration = this.config.constraints.chunkDurationSeconds - this.config.constraints.recommendedOverlapSeconds;
		const estimatedChunks = Math.ceil(totalDuration / effectiveDuration);


		return {
			needsChunking: true,
			totalChunks: estimatedChunks, // This is an estimate, actual count may vary
			chunkDuration: this.config.constraints.chunkDurationSeconds,
			overlapDuration: this.config.constraints.recommendedOverlapSeconds,
			totalDuration,
			reason: totalDuration > this.config.constraints.maxDurationSeconds ? 'duration' : 'file_size',
			estimatedProcessingTime: this.estimateProcessingTime(estimatedChunks)
		};
	}

	/**
	 * Create chunks from processed audio using VAD
	 */
	override async createChunks(
		audio: ProcessedAudio,
		strategy: ChunkStrategy
	): Promise<AudioChunk[]> {
		const startTime = performance.now();
		this.logger.debug('Starting VAD-based chunk creation', {
			audioDuration: audio.duration,
			strategyType: strategy.type
		});

		await this.ensureInitialized();

		if (!this.vadProcessor) {
			throw new Error('VAD processor not initialized');
		}


		// Process audio through VAD chunking
		const { chunks } = await this.vadProcessor.processAudioWithChunking(
			audio.pcmData,
			audio.sampleRate
		);

		// Log VAD statistics
		const elapsedTime = performance.now() - startTime;
		this.logger.info('VAD chunking completed', {
			chunkCount: chunks.length,
			elapsedTime: `${elapsedTime.toFixed(2)}ms`,
			avgChunkDuration: chunks.length > 0 ?
				`${(chunks.reduce((sum, c) => sum + (c.endTime - c.startTime), 0) / chunks.length).toFixed(2)}s` :
				'N/A'
		});

		// Update strategy with actual chunk count
		strategy.totalChunks = chunks.length;

		return chunks;
	}

	/**
	 * Cleanup VAD resources
	 */
	async cleanup(): Promise<void> {
		if (this.vadProcessor) {
			await this.vadProcessor.cleanup();
			this.vadProcessor = null;
			this.initialized = false;
		}
	}
}
