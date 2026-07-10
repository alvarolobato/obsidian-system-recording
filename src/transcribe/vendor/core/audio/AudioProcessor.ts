/**
 * Abstract base class for audio processing
 * Defines the contract for converting various audio formats to standardized PCM
 */

import { Logger } from '../../utils/Logger';

import type { AudioInput, ProcessedAudio, AudioValidationResult, AudioProcessingConfig } from './AudioTypes';

export abstract class AudioProcessor {
	protected config: AudioProcessingConfig;
	protected logger: Logger;

	constructor(config: AudioProcessingConfig) {
		this.config = config;
		this.logger = Logger.getLogger('AudioProcessor');
	}

	/**
	 * Validate audio input before processing
	 */
	abstract validate(input: AudioInput): Promise<AudioValidationResult>;

	/**
	 * Decode audio file to PCM data
	 */
	abstract decode(input: AudioInput): Promise<AudioBuffer>;

	/**
	 * Convert audio to target format (16kHz, 16-bit, mono)
	 */
	abstract convertToTargetFormat(audioBuffer: AudioBuffer): Promise<ProcessedAudio>;

	/**
	 * Apply preprocessing (VAD, noise reduction, etc.)
	 */
	abstract preprocess(audio: ProcessedAudio): Promise<ProcessedAudio>;

	/**
	 * Main processing pipeline
	 */
	async process(input: AudioInput): Promise<ProcessedAudio> {
		const startTime = performance.now();
		this.logger.debug('Starting audio processing', {
			fileType: input.fileType,
			dataSize: input.data.byteLength
		});

		// 1. Validate input
		this.logger.debug('Step 1: Validating audio input');
			const validation = await this.validate(input);
			if (!validation.isValid) {
				this.logger.error('Audio validation failed', { error: validation.error });
				throw new Error(`Audio validation failed: ${validation.error ?? 'Unknown error'}`);
			}

		// 2. Log warnings if any
		if (validation.warnings && validation.warnings.length > 0) {
			validation.warnings.forEach(warning =>
				this.logger.warn(`Audio validation warning: ${warning}`)
			);
		}

		// 3. Decode audio
		this.logger.debug('Step 2: Decoding audio');
		const decodeStart = performance.now();
		const audioBuffer = await this.decode(input);
		this.logger.debug('Audio decoded', {
			duration: `${audioBuffer.duration.toFixed(2)}s`,
			sampleRate: audioBuffer.sampleRate,
			numberOfChannels: audioBuffer.numberOfChannels,
			decodeTime: `${(performance.now() - decodeStart).toFixed(2)}ms`
		});

		// 4. Convert to target format
		this.logger.debug('Step 3: Converting to target format');
		const convertStart = performance.now();
		const processedAudio = await this.convertToTargetFormat(audioBuffer);
		this.logger.debug('Audio converted', {
			targetSampleRate: processedAudio.sampleRate,
			targetChannels: processedAudio.channels,
			convertTime: `${(performance.now() - convertStart).toFixed(2)}ms`
		});

		// 5. Apply preprocessing if enabled
		if (this.config.enableVAD || this.hasPreprocessing()) {
			this.logger.debug('Step 4: Applying preprocessing', {
				VADEnabled: this.config.enableVAD
			});
			const preprocessStart = performance.now();
			const preprocessed = await this.preprocess(processedAudio);
			this.logger.debug('Preprocessing completed', {
				preprocessTime: `${(performance.now() - preprocessStart).toFixed(2)}ms`
			});

			const totalTime = performance.now() - startTime;
			this.logger.info('Audio processing completed', {
				totalTime: `${totalTime.toFixed(2)}ms`,
				finalDuration: `${preprocessed.duration.toFixed(2)}s`
			});
			return preprocessed;
		}

		const totalTime = performance.now() - startTime;
		this.logger.info('Audio processing completed (no preprocessing)', {
			totalTime: `${totalTime.toFixed(2)}ms`,
			finalDuration: `${processedAudio.duration.toFixed(2)}s`
		});
		return processedAudio;
	}

	/**
	 * Check if any preprocessing is enabled
	 */
	protected hasPreprocessing(): boolean {
		return this.config.enableVAD;
	}

	/**
	 * Convert Float32Array PCM to WAV format ArrayBuffer
	 */
	protected pcmToWav(pcmData: Float32Array, sampleRate: number): ArrayBuffer {
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

	/**
	 * Mix stereo audio to mono
	 */
	protected mixToMono(leftChannel: Float32Array, rightChannel: Float32Array): Float32Array {
		const length = leftChannel.length;
		const mono = new Float32Array(length);

		for (let i = 0; i < length; i++) {
			const left = leftChannel[i] ?? 0;
			const right = rightChannel[i] ?? 0;
			mono[i] = (left + right) / 2;
		}

		return mono;
	}

	/**
	 * Resample audio to target sample rate
	 */
	protected resample(
		input: Float32Array,
		inputRate: number,
		outputRate: number
	): Float32Array {
		if (inputRate === outputRate) {
			return input;
		}

		const ratio = inputRate / outputRate;
		const outputLength = Math.floor(input.length / ratio);
		const output = new Float32Array(outputLength);

		for (let i = 0; i < outputLength; i++) {
			const inputIndex = i * ratio;
			const inputIndexFloor = Math.floor(inputIndex);
			const inputIndexCeil = Math.min(inputIndexFloor + 1, input.length - 1);
			const fraction = inputIndex - inputIndexFloor;

			// Linear interpolation
			const first = input[inputIndexFloor] ?? 0;
			const second = input[inputIndexCeil] ?? 0;
			output[i] = first * (1 - fraction) + second * fraction;
		}

		return output;
	}
}
