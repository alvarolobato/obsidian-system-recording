/**
 * Abstract base class for chunking services
 * Handles the logic of splitting audio into manageable chunks
 */

import { Logger } from '../../utils/Logger';

import type { ChunkStrategy, ChunkingConfig } from './ChunkingTypes';
import type { ProcessedAudio, AudioChunk } from '../audio/AudioTypes';


export abstract class ChunkingService {
	protected config: ChunkingConfig;
	protected logger: Logger;

	constructor(config: ChunkingConfig) {
		this.config = config;
		this.logger = Logger.getLogger('ChunkingService');
		this.logger.debug('ChunkingService initialized', {
			maxSizeMB: config.constraints.maxSizeMB,
			maxDurationSeconds: config.constraints.maxDurationSeconds,
			chunkDurationSeconds: config.constraints.chunkDurationSeconds,
			overlapDurationSeconds: config.constraints.overlapDurationSeconds
		});
	}

	/**
	 * Calculate chunking strategy based on audio properties and constraints
	 * Priority: 1. Time duration check, 2. File size check
	 */
	calculateStrategy(audio: ProcessedAudio): ChunkStrategy {
		const totalDuration = audio.duration;
		const estimatedSizeMB = this.estimateSize(audio);

		const { maxSizeMB, chunkDurationSeconds } = this.config.constraints;

		this.logger.debug('Calculating chunking strategy', {
			totalDuration: `${totalDuration.toFixed(2)}s`,
			estimatedSizeMB: `${estimatedSizeMB.toFixed(2)}MB`,
			chunkDurationSeconds,
			maxSizeMB
		});


		// Step 1: Check chunk duration first (not max total duration)
		const exceedsDuration = totalDuration > chunkDurationSeconds;

		if (exceedsDuration) {
			this.logger.debug('Audio exceeds chunk duration limit', {
				totalDuration: `${totalDuration.toFixed(2)}s`,
				limit: `${chunkDurationSeconds}s`
			});
			return this.createChunkingStrategy(audio, totalDuration, estimatedSizeMB, 'duration');
		}

		// Step 2: If duration is OK, check file size
		const exceedsSize = estimatedSizeMB > maxSizeMB * 0.9; // 90% threshold for safety

		if (exceedsSize) {
			this.logger.debug('Audio exceeds file size limit', {
				estimatedSizeMB: `${estimatedSizeMB.toFixed(2)}MB`,
				limit: `${(maxSizeMB * 0.9).toFixed(2)}MB`
			});
			return this.createChunkingStrategy(audio, totalDuration, estimatedSizeMB, 'file_size');
		}

		// Step 3: No chunking needed
		this.logger.debug('No chunking needed', {
			totalDuration: `${totalDuration.toFixed(2)}s`,
			estimatedSizeMB: `${estimatedSizeMB.toFixed(2)}MB`
		});
		return {
			needsChunking: false,
			totalChunks: 1,
			chunkDuration: totalDuration,
			overlapDuration: 0,
			totalDuration
		};
	}

	/**
	 * Create chunking strategy when chunking is required
	 */
	private createChunkingStrategy(
		_audio: ProcessedAudio,
		totalDuration: number,
		estimatedSizeMB: number,
		primaryReason: 'duration' | 'file_size'
	): ChunkStrategy {
		this.logger.debug('Creating chunking strategy', { primaryReason });
		const { maxSizeMB, maxDurationSeconds, chunkDurationSeconds } = this.config.constraints;

		// Calculate optimal chunk duration
		const chunkDuration = this.calculateOptimalChunkDuration(
			totalDuration,
			estimatedSizeMB,
			chunkDurationSeconds,
			maxSizeMB
		);

		// Calculate overlap
		const overlapDuration = this.config.constraints.recommendedOverlapSeconds;
		const effectiveChunkDuration = chunkDuration - overlapDuration;

		// Calculate total chunks
		let totalChunks = Math.ceil(totalDuration / effectiveChunkDuration);

		// Adjust if last chunk would be too small
		const MIN_CHUNK_DURATION = 15; // 15 seconds minimum for 30s chunks
		const lastChunkDuration = totalDuration - (totalChunks - 1) * effectiveChunkDuration;

		if (lastChunkDuration < MIN_CHUNK_DURATION && totalChunks > 1) {
			// Merge last chunk with previous one
			totalChunks--;
		}

		// Determine final reason (check if both constraints are exceeded)
		const exceedsDuration = totalDuration > maxDurationSeconds;
		const exceedsSize = estimatedSizeMB > maxSizeMB * 0.9;
		const finalReason = exceedsDuration && exceedsSize ? 'both' : primaryReason;


		const strategy: ChunkStrategy = {
			needsChunking: true,
			totalChunks,
			chunkDuration,
			overlapDuration,
			totalDuration,
			reason: finalReason,
			estimatedProcessingTime: this.estimateProcessingTime(totalChunks)
		};

		const estimatedProcessingTime = strategy.estimatedProcessingTime;
		const estimatedProcessingTimeLabel = estimatedProcessingTime === undefined
			? 'unknown'
			: `${estimatedProcessingTime}s`;

		this.logger.debug('Chunking strategy created', {
			totalChunks,
			chunkDuration: `${chunkDuration.toFixed(2)}s`,
			overlapDuration: `${overlapDuration}s`,
			reason: finalReason,
			estimatedProcessingTime: estimatedProcessingTimeLabel
		});

		return strategy;
	}

	/**
	 * Create chunks from processed audio
	 */
	abstract createChunks(
		audio: ProcessedAudio,
		strategy: ChunkStrategy
	): Promise<AudioChunk[]>;

	/**
	 * Estimate file size in MB from processed audio
	 */
	protected estimateSize(audio: ProcessedAudio): number {
		// WAV format: 44 byte header + (samples * 2 bytes per sample)
		const wavSize = 44 + (audio.pcmData.length * 2);
		const sizeMB = wavSize / (1024 * 1024);
		this.logger.trace('Estimated audio size', {
			samples: audio.pcmData.length,
			wavSize,
			sizeMB: `${sizeMB.toFixed(2)}MB`
		});
		return sizeMB;
	}

	/**
	 * Calculate optimal chunk duration considering constraints
	 * Priority: 1. Time constraint, 2. Size constraint
	 * Can be overridden to use model-specific optimal durations
	 */
	protected calculateOptimalChunkDuration(
		totalDuration: number,
		estimatedSizeMB: number,
		maxDuration: number,
		maxSizeMB: number
	): number {
		this.logger.trace('Calculating optimal chunk duration', {
			totalDuration: `${totalDuration.toFixed(2)}s`,
			estimatedSizeMB: `${estimatedSizeMB.toFixed(2)}MB`,
			maxDuration: `${maxDuration}s`,
			maxSizeMB: `${maxSizeMB}MB`
		});

		// Step 1: Apply time constraint first
		let optimalDuration = Math.min(maxDuration, totalDuration);

		// Step 2: Check if size constraint needs adjustment
		if (estimatedSizeMB > maxSizeMB) {
			const sizeFactor = maxSizeMB / estimatedSizeMB;
			const sizeBasedDuration = totalDuration * sizeFactor * 0.9; // 90% safety margin
			this.logger.trace('Size constraint requires adjustment', {
				sizeFactor,
				sizeBasedDuration: `${sizeBasedDuration.toFixed(2)}s`
			});


			if (sizeBasedDuration < optimalDuration) {
				optimalDuration = sizeBasedDuration;
			}
		}

		// Step 3: Ensure minimum viable chunk duration
		const minDuration = 60; // At least 60 seconds
		if (optimalDuration < minDuration) {
			this.logger.warn(`Calculated duration ${optimalDuration.toFixed(1)}s is below minimum ${minDuration}s - using minimum`);
			optimalDuration = minDuration;
		}

		// Step 4: Round to nearest 10 seconds for cleaner chunks
		const roundedDuration = Math.round(optimalDuration / 10) * 10;

		return roundedDuration;
	}

	/**
	 * Set preferred chunk duration (can be called from outside to use model-specific durations)
	 */
	setPreferredChunkDuration(_duration: number): void {
		// This method can be overridden by specific implementations
		// to use model-optimized chunk durations
	}

	/**
	 * Estimate total processing time based on number of chunks
	 */
	protected estimateProcessingTime(totalChunks: number): number {
		const baseTimePerChunk = 30; // seconds
		const parallelFactor = this.config.processingMode === 'parallel' ? 0.5 : 1;

		return totalChunks * baseTimePerChunk * parallelFactor;
	}

	/**
	 * Find natural boundaries in audio (silence, speech breaks)
	 */
	protected async findNaturalBoundaries(
		audio: ProcessedAudio,
		targetPositions: number[]
	): Promise<number[]> {
		if (!this.config.optimizeBoundaries) {
			return targetPositions;
		}

		// Use custom boundary detector if provided
		if (this.config.boundaryDetector) {
			const vadBoundaries = await this.config.boundaryDetector(audio);

			// If VAD boundaries are found, use them to adjust target positions
			if (vadBoundaries.length > 0) {

				// Adjust each target position to nearest VAD boundary within a reasonable window
				const adjustedPositions = targetPositions.map((target, index) => {
					// For first and last positions, keep them fixed
					if (index === 0) {
						return 0;
					}
					if (index === targetPositions.length - 1) {
						return audio.duration;
					}

					// Find nearest VAD boundary within +/- 5 seconds of target
					const windowSize = 5; // seconds
					let bestBoundary = target;
					let minDistance = windowSize;

					for (const boundary of vadBoundaries) {
						const distance = Math.abs(boundary - target);
						if (distance < minDistance) {
							minDistance = distance;
							bestBoundary = boundary;
						}
					}

					// If we found a boundary within the window, use it
					if (minDistance < windowSize) {
						return bestBoundary;
					}

					// Otherwise keep the original position
					return target;
				});

				return adjustedPositions;
			} else {
				// No VAD boundaries found, fall back to original positions
				return targetPositions;
			}
		}

		// Default: use simple silence detection
		return this.findSilenceBoundaries(audio, targetPositions);
	}

	/**
	 * Find silence boundaries near target positions
	 */
	protected findSilenceBoundaries(
		audio: ProcessedAudio,
		targetPositions: number[]
	): number[] {
		const silenceThreshold = 0.01;
		const windowSize = audio.sampleRate * 5; // 5 second window

		return targetPositions.map(targetTime => {
			const targetSample = Math.floor(targetTime * audio.sampleRate);
			const startSample = Math.max(0, targetSample - windowSize);
			const endSample = Math.min(audio.pcmData.length, targetSample + windowSize);

			let bestPosition = targetSample;
			let lowestEnergy = Infinity;

			// Find position with lowest energy (most silence)
			for (let i = startSample; i < endSample - audio.sampleRate; i += audio.sampleRate / 10) {
				const energy = this.calculateEnergy(
					audio.pcmData.slice(i, i + audio.sampleRate)
				);

				if (energy < lowestEnergy && energy < silenceThreshold) {
					lowestEnergy = energy;
					bestPosition = i;
				}
			}

			return bestPosition / audio.sampleRate;
		});
	}

	/**
	 * Calculate RMS energy of audio segment
	 */
	protected calculateEnergy(samples: Float32Array): number {
		let sum = 0;
		for (let i = 0; i < samples.length; i++) {
			const value = samples[i] ?? 0;
			sum += value * value;
		}
		return Math.sqrt(sum / samples.length);
	}

	/**
	 * Snap target positions to nearest boundaries
	 */
	protected snapToBoundaries(
		targetPositions: number[],
		boundaries: number[]
	): number[] {
		return targetPositions.map(target => {
			let closest = target;
			let minDistance = Infinity;

		for (const boundary of boundaries) {
			const distance = Math.abs(boundary - target);
				if (distance < minDistance) {
					minDistance = distance;
					closest = boundary;
				}
			}

			return closest;
		});
	}
}
