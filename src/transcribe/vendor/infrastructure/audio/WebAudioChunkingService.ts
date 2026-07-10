/**
 * Web Audio-based chunking service implementation
 * Creates audio chunks using Web Audio API
 */

import { ChunkingService } from '../../core/chunking/ChunkingService';

import type { ProcessedAudio, AudioChunk } from '../../core/audio/AudioTypes';
import type { ChunkStrategy, ChunkingConfig } from '../../core/chunking/ChunkingTypes';

export class WebAudioChunkingService extends ChunkingService {
	private preferredChunkDuration?: number;

	constructor(config: ChunkingConfig) {
		super(config);
	}

	/**
	 * Set preferred chunk duration from model config
	 */
	override setPreferredChunkDuration(duration: number): void {
		this.preferredChunkDuration = duration;
	}

	/**
	 * Calculate optimal chunk duration considering constraints and model preferences
	 * Priority: 1. Time constraint, 2. Size constraint, 3. Model preference
	 */
	protected override calculateOptimalChunkDuration(
		totalDuration: number,
		estimatedSizeMB: number,
		maxDuration: number,
		maxSizeMB: number
	): number {

		// Step 1: Check if we have a model-preferred duration
		if (this.preferredChunkDuration) {
			const preferredDuration = this.preferredChunkDuration;

			// Step 2: Check time constraint first
			if (preferredDuration > maxDuration) {
				return maxDuration;
			}

			// Step 3: Check size constraint
			const estimatedChunks = Math.ceil(totalDuration / preferredDuration);
			const estimatedChunkSizeMB = estimatedSizeMB / estimatedChunks;

			if (estimatedChunkSizeMB <= maxSizeMB) {
				return preferredDuration;
			}
			// Otherwise fall back to base calculation
		}

		// Step 4: Fallback to base constraint-based calculation
		return super.calculateOptimalChunkDuration(totalDuration, estimatedSizeMB, maxDuration, maxSizeMB);
	}

	/**
	 * Create chunks from processed audio
	 */
	override async createChunks(
		audio: ProcessedAudio,
		strategy: ChunkStrategy
	): Promise<AudioChunk[]> {
		if (!strategy.needsChunking) {
			// Single chunk
			return [this.createSingleChunk(audio)];
		}

		// Calculate chunk parameters
		const sampleRate = audio.sampleRate;
		const samplesPerChunk = Math.floor(strategy.chunkDuration * sampleRate);
		const overlapSamples = Math.floor(strategy.overlapDuration * sampleRate);
		const stepSamples = samplesPerChunk - overlapSamples;

		// Find natural boundaries if enabled
		const chunkStarts = this.calculateChunkStarts(
			audio.pcmData.length,
			samplesPerChunk,
			stepSamples,
			strategy.totalChunks
		);

		const boundaries = await this.findNaturalBoundaries(
			audio,
			chunkStarts.map(s => s / sampleRate)
		);

		// Create chunks
		const chunks: AudioChunk[] = [];

		for (let i = 0; i < boundaries.length; i++) {
			const boundary = boundaries[i] ?? 0;
			const nextBoundary = boundaries[i + 1] ?? boundary;
			const startSample = Math.floor(boundary * sampleRate);
			const endSample = i < boundaries.length - 1
				? Math.floor(nextBoundary * sampleRate) + overlapSamples
				: audio.pcmData.length;

			// Skip if chunk would be empty or too small
			if (endSample <= startSample) {
				continue;
			}

			// Extract chunk PCM data
			const chunkPcm = audio.pcmData.slice(startSample, endSample);

			// Skip if chunk is too small (less than 0.1 seconds)
			const chunkDuration = (endSample - startSample) / sampleRate;
			if (chunkDuration < 0.1) {
				continue;
			}

			// Convert to WAV
			const wavData = this.pcmToWav(chunkPcm, sampleRate);

			// Calculate timing
			const startTime = startSample / sampleRate;
			const endTime = endSample / sampleRate;
			const hasOverlap = i < boundaries.length - 1;
			const overlapDuration = hasOverlap ? strategy.overlapDuration : 0;

			chunks.push({
				id: chunks.length, // Use actual chunk count, not loop index
				data: wavData,
				startTime,
				endTime,
				hasOverlap,
				overlapDuration
			});

		}

		return chunks;
	}

	/**
	 * Calculate chunk start positions
	 */
	private calculateChunkStarts(
		totalSamples: number,
		samplesPerChunk: number,
		stepSamples: number,
		expectedChunks: number
	): number[] {
		const starts: number[] = [0];
		let currentSample = 0;

		while (currentSample + samplesPerChunk < totalSamples && starts.length < expectedChunks) {
			currentSample += stepSamples;
			starts.push(currentSample);
		}

		// Adjust last chunk if necessary
		if (starts.length > expectedChunks) {
			starts.pop();
		}

		return starts;
	}

	/**
	 * Create a single chunk from all audio
	 */
	private createSingleChunk(audio: ProcessedAudio): AudioChunk {
		const wavData = this.pcmToWav(audio.pcmData, audio.sampleRate);

		return {
			id: 0,
			data: wavData,
			startTime: 0,
			endTime: audio.duration,
			hasOverlap: false,
			overlapDuration: 0
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
			const value = pcmData[i] ?? 0;
			const sample = Math.max(-1, Math.min(1, value));
			view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
			offset += 2;
		}

		return arrayBuffer;
	}
}
