/**
 * Audio processing pipeline orchestrator
 * Coordinates the flow from raw audio input to transcription-ready chunks
 */

import { AUDIO_CONSTANTS } from '../../config/constants';
import { Logger } from '../../utils/Logger';

import type { AudioProcessor } from './AudioProcessor';
import type { AudioInput, ProcessedAudio, AudioChunk, AudioProcessingConfig } from './AudioTypes';
import type { ChunkingService } from '../chunking/ChunkingService';
import type { ChunkStrategy } from '../chunking/ChunkingTypes';



export interface AudioPipelineConfig {
	audioProcessor: AudioProcessor;
	chunkingService: ChunkingService;
	audioConfig: AudioProcessingConfig;
}

export class AudioPipeline {
	private audioProcessor: AudioProcessor;
	private chunkingService: ChunkingService;
	private config: AudioProcessingConfig;
	private logger: Logger;

	constructor(config: AudioPipelineConfig) {
		this.audioProcessor = config.audioProcessor;
		this.chunkingService = config.chunkingService;
		this.config = config.audioConfig;
		this.logger = Logger.getLogger('AudioPipeline');
		this.logger.debug('AudioPipeline initialized', {
			audioConfig: {
				sampleRate: config.audioConfig.sampleRate,
				channels: config.audioConfig.channels,
				format: config.audioConfig.format
			}
		});
	}

	/**
	 * Process audio from input to chunks ready for transcription
	 */
	async process(
		input: AudioInput,
		startTime?: number,
		endTime?: number
	): Promise<{
		chunks: AudioChunk[];
		strategy: ChunkStrategy;
		processedAudio: ProcessedAudio;
	}> {
		const startTimestamp = performance.now();
		this.logger.debug('Starting audio pipeline processing', {
			inputSize: input.data.byteLength,
			fileType: input.fileType,
			startTime,
			endTime
		});

		// Step 1: Process audio to standardized format
		this.logger.debug('Step 1: Processing audio to standardized format');
		const processedAudio = await this.audioProcessor.process(input);

		// Step 2: Apply time range if specified
		this.logger.debug('Step 2: Applying time range', { startTime, endTime });
		const trimmedAudio = this.applyTimeRange(processedAudio, startTime, endTime);
		this.logger.debug('Audio trimmed', {
			originalDuration: processedAudio.duration,
			trimmedDuration: trimmedAudio.duration
		});

		// Step 3: Calculate chunking strategy
		this.logger.debug('Step 3: Calculating chunking strategy');
		const strategy = this.chunkingService.calculateStrategy(trimmedAudio);
		this.logger.debug('Chunking strategy determined', {
			strategyType: strategy.type,
			needsChunking: strategy.needsChunking,
			chunkCount: strategy.chunkCount
		});

		// Step 4: Create chunks if needed
		this.logger.debug('Step 4: Creating chunks');
		let chunks: AudioChunk[];
		if (strategy.needsChunking) {
			this.logger.debug('Creating multiple chunks', { chunkCount: strategy.chunkCount });
			chunks = await this.chunkingService.createChunks(trimmedAudio, strategy);
		} else {
			this.logger.debug('Creating single chunk (no chunking needed)');
			chunks = [this.createSingleChunk(trimmedAudio)];
		}

		const processingTime = performance.now() - startTimestamp;
		this.logger.info('Audio pipeline processing completed', {
			chunksCreated: chunks.length,
			totalDuration: trimmedAudio.duration,
			processingTime: `${processingTime.toFixed(2)}ms`
		});

		return {
			chunks,
			strategy,
			processedAudio: trimmedAudio
		};
	}

	/**
	 * Apply time range to processed audio
	 */
	private applyTimeRange(
		audio: ProcessedAudio,
		startTime?: number,
		endTime?: number
	): ProcessedAudio {
		if (startTime === undefined && endTime === undefined) {
			this.logger.trace('No time range specified, returning original audio');
			return audio;
		}

		const sampleRate = audio.sampleRate;
		const startSample = startTime ? Math.floor(startTime * sampleRate) : 0;
		const endSample = endTime
			? Math.min(Math.floor(endTime * sampleRate), audio.pcmData.length)
			: audio.pcmData.length;

		const trimmedPcm = audio.pcmData.slice(startSample, endSample);
		const trimmedDuration = trimmedPcm.length / sampleRate;

		this.logger.trace('Audio trimmed', {
			originalSamples: audio.pcmData.length,
			trimmedSamples: trimmedPcm.length,
			startSample,
			endSample,
			trimmedDuration: `${trimmedDuration.toFixed(2)}s`
		});

		return {
			...audio,
			pcmData: trimmedPcm,
			duration: trimmedDuration
		};
	}

	/**
	 * Create a single chunk from processed audio
	 */
	private createSingleChunk(audio: ProcessedAudio): AudioChunk {
		this.logger.trace('Creating single chunk from audio');

		// Convert to WAV format
		const wavData = this.audioProcessor['pcmToWav'](audio.pcmData, audio.sampleRate);

		const chunk: AudioChunk = {
			id: 0,
			data: wavData,
			startTime: 0,
			endTime: audio.duration,
			hasOverlap: false,
			overlapDuration: 0
		};

		this.logger.trace('Single chunk created', {
			chunkSize: wavData.byteLength,
			duration: `${audio.duration.toFixed(2)}s`
		});

		return chunk;
	}

	/**
	 * Validate pipeline configuration
	 */
	validateConfiguration(): void {
		// Validate audio processing config
		if (this.config.targetSampleRate !== AUDIO_CONSTANTS.SAMPLE_RATE) {
			this.logger.warn('Target sample rate is not 16kHz, which is optimal for transcription APIs');
		}

		if (this.config.targetChannels !== AUDIO_CONSTANTS.CHANNELS) {
			this.logger.warn('Target channels is not mono, which is required for transcription APIs');
		}

		if (this.config.targetBitDepth !== AUDIO_CONSTANTS.BIT_DEPTH) {
			this.logger.warn('Target bit depth is not 16-bit, which is standard for transcription APIs');
		}
	}

	/**
	 * Get pipeline statistics
	 */
	getStatistics(
		input: AudioInput,
		processedAudio: ProcessedAudio,
		chunks: AudioChunk[]
	): {
		inputSize: number;
		processedSize: number;
		compressionRatio: number;
		totalChunks: number;
		averageChunkDuration: number;
		processingGain: string;
	} {
		const processedSize = processedAudio.pcmData.length * 2 + 44; // WAV size
		const compressionRatio = input.size / processedSize;
		const totalDuration = chunks.reduce((sum, chunk) => sum + (chunk.endTime - chunk.startTime), 0);
		const averageChunkDuration = totalDuration / chunks.length;

		return {
			inputSize: input.size,
			processedSize,
			compressionRatio,
			totalChunks: chunks.length,
			averageChunkDuration,
			processingGain: compressionRatio > 1 ? 'compression' : 'expansion'
		};
	}
}
