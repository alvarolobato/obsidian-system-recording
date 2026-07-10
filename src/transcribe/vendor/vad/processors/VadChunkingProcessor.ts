
import { AUDIO_CONSTANTS } from '../../config/constants';
import { getModelConfig } from '../../config/ModelProcessingConfig';

import { WebRTCVADProcessor } from './WebrtcVadProcessor';

import type { AudioChunk } from '../../core/audio/AudioTypes';
import type { ChunkingConfig } from '../../core/chunking/ChunkingTypes';
import type { VADConfig, VADResult, SpeechSegment } from '../VadTypes';
import type { App } from 'obsidian';

/**
 * Chunk information during VAD processing
 */
interface ChunkInfo {
	startTime: number;
	endTime: number;
	startSample: number;
	endSample: number;
	audioData: Float32Array[];
	isSpeech: boolean[];
}

/**
 * VAD-based chunking processor
 * Integrates WebRTC VAD with chunk generation in a single pass
 */
export class VADChunkingProcessor extends WebRTCVADProcessor {
	private minChunkDuration: number;
	private maxChunkDuration: number;
	private preferredChunkDuration: number;
	private overlapDuration: number;
	private minSilenceForSplit: number;
	private forceSplitAfterExtra: number;
	private minChunkSize: number;

	constructor(
		app: App,
		vadConfig: VADConfig,
		chunkingConfig: ChunkingConfig,
		pluginId?: string
	) {
		super(app, vadConfig, pluginId);

		// Get model name from chunking config
		const modelName = chunkingConfig.modelName;
		if (!modelName) {
			throw new Error('[VADChunkingProcessor] Model name is required in chunkingConfig');
		}
		const modelConfig = getModelConfig(modelName);

		// Use model-specific VAD settings (required)
		const vadChunkingConfig = modelConfig.vadChunking;

		// Set chunk duration parameters
		this.minChunkDuration = vadChunkingConfig.minChunkDuration;
		this.maxChunkDuration = vadChunkingConfig.maxChunkDuration;
		this.preferredChunkDuration = chunkingConfig.constraints.chunkDurationSeconds;
		this.overlapDuration = chunkingConfig.constraints.recommendedOverlapSeconds;

		// Set VAD chunking parameters
		this.minSilenceForSplit = vadChunkingConfig.minSilenceForSplit;
		this.forceSplitAfterExtra = vadChunkingConfig.forceSplitAfterExtra;
		this.minChunkSize = vadChunkingConfig.minChunkSize;

		// Log configuration for debugging
	}

	/**
	 * Process audio and create chunks in a single pass
	 */
	processAudioWithChunking(
		audioData: Float32Array,
		sampleRate: number
	): Promise<{ vadResult: VADResult; chunks: AudioChunk[] }> {
		if (!this.available || !this.vadInstance || !this.bufferPtr) {
			throw new Error('VAD not initialized');
		}

		const startTime = performance.now();

		try {
			// 1. Resample if needed (to 16kHz for VAD)
			let processData = audioData;
			let vadSampleRate = sampleRate;
			if (sampleRate !== AUDIO_CONSTANTS.SAMPLE_RATE) {
				processData = this.resampleTo16kHz(audioData, sampleRate);
				vadSampleRate = AUDIO_CONSTANTS.SAMPLE_RATE;
			}

			// 2. Convert to Int16 for VAD
			const int16Data = this.convertFloat32ToInt16(processData);

			// 3. Process with VAD and create chunks simultaneously
			const { segments, chunks } = this.detectVoiceSegmentsAndChunks(
				int16Data,
				audioData,
				vadSampleRate,
				sampleRate
			);

			// 4. Post-process segments (but not chunks - they're already final)
			const processedSegments = this.postProcessSegments(segments);

			// 5. Extract speech segments for VAD result
			const processedAudio = this.extractSpeechSegments(audioData, processedSegments, sampleRate);

			// 6. Create VAD result
			const vadResult = this.createResult(
				audioData,
				processedAudio,
				processedSegments,
				sampleRate,
				performance.now() - startTime
			);

			return Promise.resolve({ vadResult, chunks });
		} catch (error) {
			this.logger.error('Processing error', error);
			throw error;
		}
	}

	/**
	 * Detect voice segments and create chunks in a single pass
	 */
	private detectVoiceSegmentsAndChunks(
		int16Data: Int16Array,
		originalAudio: Float32Array,
		vadSampleRate: number,
		originalSampleRate: number
	): { segments: SpeechSegment[]; chunks: AudioChunk[] } {
		const fvadModule = this.fvadModule;
		const vadInstance = this.vadInstance;
		const bufferPtr = this.bufferPtr;
		if (!this.available || !fvadModule || !vadInstance || bufferPtr === null) {
			throw new Error('VAD not initialized');
		}

		const segments: SpeechSegment[] = [];
		const chunks: AudioChunk[] = [];

		let currentSegment: SpeechSegment | null = null;
		let currentChunk: ChunkInfo | null = null;

		// Frame processing variables
		const totalFrames = Math.floor(int16Data.length / this.frameSize);
		const frameDuration = this.frameSize / vadSampleRate; // 30ms per frame

		// Chunk management variables
		let lastChunkEndTime = 0;
		let consecutiveSilenceTime = 0;

		for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
			const offset = frameIndex * this.frameSize;
			const frameTime = offset / vadSampleRate;

			// Copy frame data to WASM memory
			const frame = int16Data.subarray(offset, offset + this.frameSize);
			fvadModule.HEAP16.set(frame, bufferPtr >> 1);

			// VAD processing
			const isSpeech = fvadModule._fvad_process(
				vadInstance,
				bufferPtr,
				this.frameSize
			);

			if (isSpeech < 0) {
				this.logger.warn('Frame processing error', { frameIndex });
				continue;
			}

			// Update speech segments (existing logic)
			if (isSpeech === 1) {
				consecutiveSilenceTime = 0;
				if (!currentSegment) {
					currentSegment = {
						start: frameTime,
						end: frameTime + frameDuration
					};
				} else {
					currentSegment.end = frameTime + frameDuration;
				}
			} else {
				consecutiveSilenceTime += frameDuration;
				if (currentSegment) {
					segments.push(currentSegment);
					currentSegment = null;
				}
			}

			// Chunk creation logic
			// Start new chunk (if needed)
			currentChunk ??= this.createNewChunk(frameTime, frameIndex, lastChunkEndTime);

			// Add frame data to current chunk
			const originalFrameStart = Math.floor((frameTime * originalSampleRate) / vadSampleRate * originalSampleRate);
			const originalFrameEnd = Math.floor(((frameTime + frameDuration) * originalSampleRate) / vadSampleRate * originalSampleRate);
			const originalFrameData = originalAudio.slice(originalFrameStart, originalFrameEnd);

			currentChunk.audioData.push(originalFrameData);
			currentChunk.isSpeech.push(isSpeech === 1);
			currentChunk.endTime = frameTime + frameDuration;

			// Check if we should finalize the chunk
			const chunkDuration = currentChunk.endTime - currentChunk.startTime;
			const shouldSplit = this.shouldSplitChunk(
				chunkDuration,
				consecutiveSilenceTime,
				isSpeech === 1,
				frameIndex === totalFrames - 1
			);

			if (shouldSplit) {
				// Finalize current chunk
				const finalizedChunk = this.finalizeChunk(
					currentChunk,
					chunks.length,
					originalAudio,
					originalSampleRate,
					lastChunkEndTime
				);

				if (finalizedChunk) {
					chunks.push(finalizedChunk);
					lastChunkEndTime = currentChunk.endTime - this.overlapDuration;
				}

				currentChunk = null;
			}
		}

		// Handle last segment
		if (currentSegment) {
			segments.push(currentSegment);
		}

		// Handle last chunk
		if (currentChunk && currentChunk.audioData.length > 0) {
			const finalizedChunk = this.finalizeChunk(
				currentChunk,
				chunks.length,
				originalAudio,
				originalSampleRate,
				lastChunkEndTime
			);
			if (finalizedChunk) {
				chunks.push(finalizedChunk);
			}
		}

		return { segments, chunks };
	}

	/**
	 * Determine if we should split at current position
	 */
	private shouldSplitChunk(
		currentDuration: number,
		consecutiveSilenceTime: number,
		isCurrentFrameSpeech: boolean,
		isLastFrame: boolean
	): boolean {
		// Always split at the last frame
		if (isLastFrame) {
			return true;
		}

		// Must split if we've reached maximum duration
		if (currentDuration >= this.maxChunkDuration) {
			return true;
		}

		// Don't split if we haven't reached minimum duration
		if (currentDuration < this.minChunkDuration) {
			return false;
		}

		// If we're past preferred duration and found significant silence, split
		if (currentDuration >= this.preferredChunkDuration &&
		    consecutiveSilenceTime >= this.minSilenceForSplit &&
		    !isCurrentFrameSpeech) {
			return true;
		}

		// If we're way past preferred duration and found any silence, split
		if (currentDuration >= this.preferredChunkDuration + this.forceSplitAfterExtra &&
		    consecutiveSilenceTime > this.minSilenceForSplit / 5 && // 20% of minSilenceForSplit
		    !isCurrentFrameSpeech) {
			return true;
		}

		return false;
	}

	/**
	 * Create a new chunk info object
	 */
	private createNewChunk(startTime: number, frameIndex: number, lastChunkEndTime: number): ChunkInfo {
		// Add overlap from previous chunk if not the first chunk
		const actualStartTime = frameIndex === 0 ? startTime : lastChunkEndTime;

		return {
			startTime: actualStartTime,
			endTime: startTime,
			startSample: 0,
			endSample: 0,
			audioData: [],
			isSpeech: []
		};
	}

	/**
	 * Finalize a chunk and prepare it for output
	 */
	private finalizeChunk(
		chunkInfo: ChunkInfo,
		chunkId: number,
		originalAudio: Float32Array,
		sampleRate: number,
		lastChunkEndTime: number
	): AudioChunk | null {
		// Calculate actual samples from original audio
		const startSample = Math.floor(chunkInfo.startTime * sampleRate);
		const endSample = Math.min(
			originalAudio.length,
			Math.floor(chunkInfo.endTime * sampleRate)
		);

		// Extract chunk audio
		const chunkAudio = originalAudio.slice(startSample, endSample);

		// Skip if too small
		if (chunkAudio.length < sampleRate * this.minChunkSize) {
			return null;
		}

		// Convert to WAV
		const wavData = this.pcmToWav(chunkAudio, sampleRate);

		// Determine if this chunk has overlap with next
		const hasOverlap = chunkInfo.endTime > lastChunkEndTime + this.overlapDuration;

		return {
			id: chunkId,
			data: wavData,
			startTime: chunkInfo.startTime,
			endTime: chunkInfo.endTime,
			hasOverlap,
			overlapDuration: hasOverlap ? this.overlapDuration : 0
		};
	}

	/**
	 * Convert PCM to WAV format
	 */
	private pcmToWav(pcmData: Float32Array, sampleRate: number): ArrayBuffer {
		const length = pcmData.length;
		const arrayBuffer = new ArrayBuffer(44 + length * 2);
		const view = new DataView(arrayBuffer);

		// WAV header
		const writeString = (offset: number, string: string) => {
			for (let i = 0; i < string.length; i++) {
				view.setUint8(offset + i, string.charCodeAt(i));
			}
		};

		writeString(0, 'RIFF');
		view.setUint32(4, 36 + length * 2, true);
		writeString(8, 'WAVE');
		writeString(12, 'fmt ');
		view.setUint32(16, 16, true); // fmt chunk size
		view.setUint16(20, 1, true); // PCM format
		view.setUint16(22, 1, true); // mono
		view.setUint32(24, sampleRate, true);
		view.setUint32(28, sampleRate * 2, true); // byte rate
		view.setUint16(32, 2, true); // block align
		view.setUint16(34, 16, true); // bits per sample
		writeString(36, 'data');
		view.setUint32(40, length * 2, true);

			// Convert float32 to int16
			let offset = 44;
			for (let i = 0; i < length; i++) {
				const sample = Math.max(-1, Math.min(1, pcmData[i] ?? 0));
				view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
				offset += 2;
			}

		return arrayBuffer;
	}
}
