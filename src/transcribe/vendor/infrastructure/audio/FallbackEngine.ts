/**
 * Fallback audio engine for when Web Audio API is not available
 * Simple implementation that works with pre-chunked files
 */

import { getModelConfig } from '../../config/ModelProcessingConfig';
import { AudioProcessor } from '../../core/audio/AudioProcessor';

import type {
	AudioInput,
	ProcessedAudio,
	AudioValidationResult,
	AudioProcessingConfig
} from '../../core/audio/AudioTypes';

export class FallbackEngine extends AudioProcessor {
	constructor(config: AudioProcessingConfig) {
		super(config);
		this.logger.warn('Using fallback audio processor - limited functionality');
	}

	/**
	 * Validate audio input
	 */
	validate(input: AudioInput): Promise<AudioValidationResult> {
		const validation: AudioValidationResult = {
			isValid: true,
			warnings: []
		};

		// More restrictive for fallback
		const maxSizeMB = 25; // Match API limits
		const sizeMB = input.size / (1024 * 1024);

		if (sizeMB > maxSizeMB) {
			validation.isValid = false;
			validation.error = `File size ${sizeMB.toFixed(1)}MB exceeds maximum ${maxSizeMB}MB for fallback processor`;
			return Promise.resolve(validation);
		}

		// Only support WAV in fallback mode
		if (input.extension.toLowerCase() !== 'wav') {
			validation.isValid = false;
			validation.error = `Fallback processor only supports WAV format, got '${input.extension}'`;
			return Promise.resolve(validation);
		}

		// Check if it's a valid WAV file
		const header = new DataView(input.data.slice(0, 44));
		const riff = String.fromCharCode(...new Uint8Array(input.data.slice(0, 4)));
		const wave = String.fromCharCode(...new Uint8Array(input.data.slice(8, 12)));

		if (riff !== 'RIFF' || wave !== 'WAVE') {
			validation.isValid = false;
			validation.error = 'Invalid WAV file format';
			return Promise.resolve(validation);
		}

		// Extract WAV properties
		const sampleRate = header.getUint32(24, true);
		const bitsPerSample = header.getUint16(34, true);
		const channels = header.getUint16(22, true);
		const dataSize = header.getUint32(40, true);
		const duration = dataSize / (sampleRate * channels * (bitsPerSample / 8));

		validation.properties = {
			format: 'wav',
			duration,
			sampleRate,
			channels,
			bitrate: sampleRate * channels * bitsPerSample
		};

				// Warnings for non-optimal settings
				if (sampleRate !== this.config.targetSampleRate) {
					validation.warnings ??= [];
					validation.warnings.push(`Sample rate ${sampleRate}Hz will be passed as-is (no resampling in fallback mode)`);
				}
				if (channels !== 1) {
					validation.warnings ??= [];
					validation.warnings.push(`${channels} channels detected (fallback mode does not support mixing to mono)`);
				}

		return Promise.resolve(validation);
	}

	/**
	 * Decode audio - in fallback mode, just parse WAV header
	 */
	decode(input: AudioInput): Promise<AudioBuffer> {
		// Since we only support WAV, we can create a simple AudioBuffer-like object
		const view = new DataView(input.data);

		// Read WAV header
		const sampleRate = view.getUint32(24, true);
		const channels = view.getUint16(22, true);
		const bitsPerSample = view.getUint16(34, true);
		const dataSize = view.getUint32(40, true);

		// Calculate properties
		const bytesPerSample = bitsPerSample / 8;
		const samplesPerChannel = dataSize / (channels * bytesPerSample);
		const duration = samplesPerChannel / sampleRate;

		// Create pseudo AudioBuffer
		const audioBuffer = {
			sampleRate,
			length: samplesPerChannel,
			duration,
			numberOfChannels: channels,
			getChannelData: (channel: number) => {
				// Extract channel data from interleaved WAV data
				const channelData = new Float32Array(samplesPerChannel);
				const dataStart = 44; // WAV header size

				for (let i = 0; i < samplesPerChannel; i++) {
					const sampleOffset = dataStart + (i * channels + channel) * bytesPerSample;

					if (bitsPerSample === 16) {
						const sample = view.getInt16(sampleOffset, true) / 32768;
						channelData[i] = sample;
					} else if (bitsPerSample === 8) {
						const sample = (view.getUint8(sampleOffset) - 128) / 128;
						channelData[i] = sample;
					} else {
						// Unsupported bit depth, use silence
						channelData[i] = 0;
					}
				}

				return channelData;
			}
		} as unknown as AudioBuffer;


		return Promise.resolve(audioBuffer);
	}

	/**
	 * Convert to target format - limited in fallback mode
	 */
	convertToTargetFormat(audioBuffer: AudioBuffer): Promise<ProcessedAudio> {
		// In fallback mode, we can't resample, so just extract the data
		const pcmData = audioBuffer.getChannelData(0); // Just use first channel

		if (audioBuffer.sampleRate !== this.config.targetSampleRate) {
			this.logger.warn('Cannot resample audio in fallback mode', {
				from: audioBuffer.sampleRate,
				to: this.config.targetSampleRate
			});
		}

		if (audioBuffer.numberOfChannels > 1) {
			this.logger.warn('Cannot mix channels to mono in fallback mode', {
				channels: audioBuffer.numberOfChannels
			});
		}

		return Promise.resolve({
			pcmData: new Float32Array(pcmData), // Make a copy
			sampleRate: audioBuffer.sampleRate, // Keep original sample rate
			duration: audioBuffer.duration,
			channels: 1,
			source: audioBuffer as unknown as AudioInput
		});
	}

	/**
	 * Preprocess - not supported in fallback mode
	 */
	preprocess(audio: ProcessedAudio): Promise<ProcessedAudio> {
		if (this.config.enableVAD) {
			this.logger.warn('VAD preprocessing not supported in fallback mode');
		}
		return Promise.resolve(audio);
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
			supportsResampling: false,
			supportsVAD: false,
			maxChannels: 2,
			supportedFormats: ['wav']
		};
	}

	/**
	 * Check if fallback engine can handle the input
	 */
	static canHandle(input: AudioInput): boolean {
		// デフォルトでWhisperモデルの制限を使用（最も一般的なケース）
		const whisperConfig = getModelConfig('whisper-1');
		const maxSizeBytes = whisperConfig.maxFileSizeMB * 1024 * 1024;

		return input.extension.toLowerCase() === 'wav' &&
		       input.size < maxSizeBytes;
	}
}
