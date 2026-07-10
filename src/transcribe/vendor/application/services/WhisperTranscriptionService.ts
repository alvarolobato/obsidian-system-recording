/**
 * Whisper transcription service implementation
 * Bridges the core TranscriptionService interface with Whisper API client
 */

import { getModelConfig } from '../../config/ModelProcessingConfig';
import { TranscriptionService } from '../../core/transcription/TranscriptionService';
import { WhisperClient } from '../../infrastructure/api/openai/WhisperClient';
import { Logger } from '../../utils/Logger';

import type { AudioChunk } from '../../core/audio/AudioTypes';
import type { DictionaryCorrector } from '../../core/transcription/DictionaryCorrector';
import type {
	TranscriptionResult,
	TranscriptionOptions,
	ModelSpecificOptions,
	TranscriptionRequest,
	TranscriptionValidation
} from '../../core/transcription/TranscriptionTypes';


export class WhisperTranscriptionService extends TranscriptionService {
	readonly modelId: string;
	readonly modelName = 'OpenAI Whisper';

	readonly capabilities: {
		supportsTimestamps: boolean;
		supportsWordLevel: boolean;
		supportsLanguageDetection: boolean;
		supportedLanguages: string[];
		maxFileSizeMB: number;
		maxDurationSeconds: number;
	};

	private client: WhisperClient;

	constructor(apiKey: string, modelId: string = 'whisper-1', dictionaryCorrector?: DictionaryCorrector) {
		super();

		this.modelId = modelId;

		// Initialize capabilities based on model
		const config = getModelConfig(this.modelId);
		const includeTimestamps = this.modelId === 'whisper-1-ts';
		this.capabilities = {
			supportsTimestamps: includeTimestamps,
			supportsWordLevel: includeTimestamps,
			supportsLanguageDetection: true,
			supportedLanguages: [
				'af', 'ar', 'hy', 'az', 'be', 'bs', 'bg', 'ca', 'zh', 'hr', 'cs',
				'da', 'nl', 'en', 'et', 'fi', 'fr', 'gl', 'de', 'el', 'he', 'hi',
				'hu', 'is', 'id', 'it', 'ja', 'kn', 'kk', 'ko', 'lv', 'lt', 'mk',
				'ms', 'mr', 'mi', 'ne', 'no', 'fa', 'pl', 'pt', 'ro', 'ru', 'sr',
				'sk', 'sl', 'es', 'sw', 'sv', 'tl', 'ta', 'th', 'tr', 'uk', 'ur',
				'vi', 'cy'
			],
			maxFileSizeMB: config.maxFileSizeMB,
			maxDurationSeconds: config.maxDurationSeconds
		};

		// Dictionary corrector is now handled at the controller level
		this.dictionaryCorrector = dictionaryCorrector;

		this.client = new WhisperClient(apiKey);
		this.logger = Logger.getLogger('WhisperTranscriptionService');
		this.logger.debug('WhisperTranscriptionService initialized', {
			model: this.modelId,
			capabilities: {
				maxFileSizeMB: this.capabilities.maxFileSizeMB,
				maxDurationSeconds: this.capabilities.maxDurationSeconds,
				supportsTimestamps: this.capabilities.supportsTimestamps
			}
		});
	}

	/**
	 * Validate transcription request
	 */
	validate(request: TranscriptionRequest): Promise<TranscriptionValidation> {
		this.logger.debug('Validating transcription request', {
			chunkId: request.chunk.id,
			language: request.options.language
		});

		const errors: string[] = [];
		const warnings: string[] = [];

		// Check chunk size
		const chunkSizeMB = request.chunk.data.byteLength / (1024 * 1024);
		if (chunkSizeMB > this.capabilities.maxFileSizeMB) {
			this.logger.warn('Chunk size exceeds limit', {
				chunkSizeMB: chunkSizeMB.toFixed(1),
				limit: this.capabilities.maxFileSizeMB
			});
			errors.push(`Chunk size ${chunkSizeMB.toFixed(1)}MB exceeds Whisper limit of ${this.capabilities.maxFileSizeMB}MB`);
		}

		// Check language support
		if (request.options.language && request.options.language !== 'auto') {
			if (!this.isLanguageSupported(request.options.language)) {
				this.logger.warn('Unsupported language', {
					language: request.options.language
				});
				errors.push(`Language '${request.options.language}' is not supported by Whisper`);
			}
		}

		// Estimate cost
		const duration = request.chunk.endTime - request.chunk.startTime;
		const cost = this.estimateCost(duration);

		return Promise.resolve({
			isValid: errors.length === 0,
			errors,
			warnings,
			estimatedCost: cost
		});
	}

	/**
	 * Transcribe audio chunk
	 */
	async transcribe(
		chunk: AudioChunk,
		options: TranscriptionOptions,
		modelOptions?: ModelSpecificOptions
	): Promise<TranscriptionResult> {
		const startTime = performance.now();
		this.logger.debug('Starting transcription', {
			chunkId: chunk.id,
			chunkDuration: `${(chunk.endTime - chunk.startTime).toFixed(2)}s`,
			language: options.language
		});

		// Determine if timestamps should be included based on model
		const includeTimestamps = this.modelId === 'whisper-1-ts';

		// Whisper-specific model options
		const whisperOptions: ModelSpecificOptions = {
			whisper: {
				// Always use verbose_json to get all available data including timestamps
				// The model differentiation is in whether we request timestampGranularities
				responseFormat: modelOptions?.whisper?.responseFormat || 'verbose_json',
				...(includeTimestamps && { timestampGranularities: ['segment'] }),
				...modelOptions?.whisper
			}
		};

		try {
			const result = await this.client.transcribe(chunk, options, whisperOptions);

			const transcriptionTime = performance.now() - startTime;
			this.logger.info('Transcription completed', {
				chunkId: chunk.id,
				transcriptionTime: `${transcriptionTime.toFixed(2)}ms`,
				resultLength: result.text.length,
				detectedLanguage: result.language
			});

			return result;
		} catch (error) {
			this.logger.error('Transcription failed', {
				chunkId: chunk.id,
				error
			});
			throw error;
		}
	}

	/**
	 * Test API connection
	 */
	async testConnection(apiKey: string): Promise<boolean> {
		this.logger.debug('Testing Whisper API connection');
		try {
			const testClient = new WhisperClient(apiKey);
			const result = await testClient.testConnection();
			this.logger.info('Connection test completed', { success: result });
			return result;
		} catch (error) {
			this.logger.error('Connection test failed', error);
			return false;
		}
	}

	/**
	 * Estimate transcription cost
	 */
	estimateCost(durationSeconds: number): {
		amount: number;
		currency: string;
		perMinute: number;
	} {
		// Get pricing from configuration
		const config = getModelConfig(this.modelId);
		const perMinute = config.pricing.costPerMinute;
		const currency = config.pricing.currency;

		const minutes = durationSeconds / 60;
		const amount = minutes * perMinute;

		return {
			amount: Math.round(amount * 1000) / 1000, // Round to 3 decimal places
			currency,
			perMinute
		};
	}

	/**
	 * Get optimal chunk duration for Whisper
	 */
	getOptimalChunkDuration(): number {
		const config = getModelConfig(this.modelId);
		return config.chunkDurationSeconds;
	}

	/**
	 * Get Whisper-specific prompts
	 */
	getLanguagePrompt(language: string): string {
		const prompts = {
			ja: 'これは日本語の音声です。正確に文字起こしを行ってください。',
			en: 'This is English audio. Please transcribe accurately.',
			zh: '这是中文音频。请准确转录。',
			ko: '이것은 한국어 음성입니다. 정확하게 텍스트로 변환해주세요.',
			es: 'Este es audio en español. Por favor, transcribe con precisión.',
			fr: 'Ceci est un audio en français. Veuillez transcrire avec précision.',
			de: 'Dies ist eine deutsche Audioaufnahme. Bitte transkribieren Sie genau.',
			auto: 'Please transcribe this audio accurately in its original language.'
		} as const satisfies Record<string, string>;

		const prompt = language in prompts
			? (prompts as Record<string, string>)[language]
			: undefined;
		return prompt ?? prompts.auto;
	}
}
