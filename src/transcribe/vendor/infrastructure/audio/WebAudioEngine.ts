/**
 * Web Audio API implementation for audio processing
 * Primary audio engine for browser environment
 */

import { SUPPORTED_FORMATS, APP_LIMITS, FileTypeUtils } from '../../config/constants';
import { AudioProcessor } from '../../core/audio/AudioProcessor';
import { ResourceManager } from '../../core/resources/ResourceManager';
import { t } from '../../i18n';

import type {
	AudioInput,
	ProcessedAudio,
	AudioValidationResult,
	AudioProcessingConfig
} from '../../core/audio/AudioTypes';

export class WebAudioEngine extends AudioProcessor {
	private audioContext: AudioContext | null = null;
	private resourceId: string;
	private resourceManager: ResourceManager;

	constructor(config: AudioProcessingConfig) {
		super(config);
		this.resourceId = `audio-engine-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
		this.resourceManager = ResourceManager.getInstance();
	}

	/**
	 * Initialize Web Audio API context
	 */
	private async initializeContext(): Promise<void> {
		if (!this.audioContext) {
			try {
				// Get AudioContext from ResourceManager
				this.audioContext = await this.resourceManager.getAudioContext(
					this.resourceId,
					{ sampleRate: this.config.targetSampleRate }
				);
			} catch (error) {
				this.logger.error('Failed to initialize audio context', error);
				throw new Error('Web Audio API not available in this environment');
			}
		}
	}

	/**
	 * Validate audio input
	 */
	async validate(input: AudioInput): Promise<AudioValidationResult> {
		const warnings: string[] = [];
		const validation: AudioValidationResult = {
			isValid: true,
			warnings
		};

		// Check file size for warning
		const sizeMB = input.size / (1024 * 1024);
		const warningSizeMB = APP_LIMITS.LARGE_FILE_WARNING_SIZE_MB;

			if (sizeMB > warningSizeMB) {
				warnings.push(`大きなファイル（${sizeMB.toFixed(1)} MB）の処理には時間がかかる場合があります`);
			}

		// Check extension
			const supportedExtensions = SUPPORTED_FORMATS.EXTENSIONS;
			if (!supportedExtensions.includes(input.extension.toLowerCase())) {
				warnings.push(`File extension '${input.extension}' may not be supported`);
			}

		// Try to decode a small portion to validate format
			try {
				await this.initializeContext();
				if (!this.audioContext) {
					throw new Error('AudioContext not initialized');
				}
				// Just check if we can create the audio context
				validation.properties = {
					format: input.extension,
					duration: 0, // Will be determined during decode
					sampleRate: this.audioContext.sampleRate,
				channels: 0 // Will be determined during decode
			};
		} catch (error) {
			this.logger.error('Failed to initialize audio processing context', error);
			validation.isValid = false;
			validation.error = 'Failed to initialize audio processing';
		}

		return validation;
	}

	/**
	 * Decode audio file using Web Audio API
	 */
	async decode(input: AudioInput): Promise<AudioBuffer> {
		await this.initializeContext();
		if (!this.audioContext) {
			throw new Error('AudioContext not initialized');
		}

		try {
			// Clone the buffer as decodeAudioData consumes it
			const bufferCopy = input.data.slice(0);
			const audioBuffer = await this.audioContext.decodeAudioData(bufferCopy);


			// Check if audio was successfully extracted
			if (audioBuffer.duration === 0) {
				// Check if this is a video file
				if (input.extension && FileTypeUtils.isVideoFile(input.extension)) {
					throw new Error(t('errors.messages.noAudioTrack'));
				}
				throw new Error('Audio decoding resulted in empty audio buffer.');
			}

			return audioBuffer;
		} catch (error) {
			this.logger.error('Failed to decode audio', error);

			// Check if this is a video-specific error
			if (input.extension && FileTypeUtils.isVideoFile(input.extension)) {
				// More specific error message for video files
				if (error instanceof Error) {
					if (error.message.includes('decoding')) {
						throw new Error(t('errors.messages.unsupportedVideoCodec'));
					}
					if (error.message === t('errors.messages.noAudioTrack')) {
						throw error; // Re-throw our custom error
					}
				}
			}

			throw new Error('Audio decoding failed. The file may be corrupted or in an unsupported format.');
		}
	}

	/**
	 * Convert audio to target format
	 */
	convertToTargetFormat(audioBuffer: AudioBuffer): Promise<ProcessedAudio> {
		const targetSampleRate = this.config.targetSampleRate;

		// Get mono channel
		const monoData = audioBuffer.numberOfChannels > 1
			? this.mixToMono(
				audioBuffer.getChannelData(0),
				audioBuffer.getChannelData(1)
			)
			: audioBuffer.getChannelData(0);

		// Resample if needed
		let processedData: Float32Array;
		if (audioBuffer.sampleRate !== targetSampleRate) {
			processedData = this.resample(monoData, audioBuffer.sampleRate, targetSampleRate);
		} else {
			processedData = new Float32Array(monoData);
		}

		return Promise.resolve({
			pcmData: processedData,
			sampleRate: targetSampleRate,
			duration: processedData.length / targetSampleRate,
			channels: 1,
			source: audioBuffer as unknown as AudioInput // Store original for reference
		});
	}

	/**
	 * Apply preprocessing (VAD, etc.)
	 */
	preprocess(audio: ProcessedAudio): Promise<ProcessedAudio> {
		if (!this.config.enableVAD) {
			return Promise.resolve(audio);
		}

		// VAD is handled at the file level by TranscriptionController before chunking
		return Promise.resolve(audio);
	}

	/**
	 * Cleanup resources
	 */
	async cleanup(): Promise<void> {
		// Use ResourceManager to close AudioContext
		await this.resourceManager.closeAudioContext(this.resourceId);
		this.audioContext = null;
	}

	/**
	 * Check if Web Audio API is available
	 */
	static isAvailable(): boolean {
		if (typeof window === 'undefined') {
			return false;
		}
		const win = window as unknown as Record<string, unknown>;
		return typeof win['AudioContext'] === 'function' || typeof win['webkitAudioContext'] === 'function';
	}

	/**
	 * Get engine capabilities
	 */
	getCapabilities(): {
		supportsResampling: boolean;
		supportsVAD: boolean;
		maxChannels: number;
		supportedFormats: string[];
		} {
		return {
			supportsResampling: true,
			supportsVAD: false, // VAD is handled separately
			maxChannels: 32,
			supportedFormats: SUPPORTED_FORMATS.EXTENSIONS
		};
	}
}
