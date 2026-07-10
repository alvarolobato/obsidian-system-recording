/**
 * GPT-4o transcription service implementation
 * Bridges the core TranscriptionService interface with GPT-4o API client
 */

import { getModelConfig } from '../../config/ModelProcessingConfig';
import { TranscriptionService } from '../../core/transcription/TranscriptionService';
import { GPT4oClient } from '../../infrastructure/api/openai/GPT4oClient';
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


export class GPT4oTranscriptionService extends TranscriptionService {
	readonly modelId: string;
	readonly modelName: string;

	readonly capabilities = {
		supportsTimestamps: false, // Basic JSON format doesn't include timestamps
		supportsWordLevel: false,
		supportsLanguageDetection: true,
		supportedLanguages: [
			'ja', 'en', 'zh', 'ko', 'es', 'fr', 'de', 'it', 'pt', 'ru',
			'ar', 'hi', 'th', 'vi', 'nl', 'pl', 'tr', 'he', 'id', 'sv'
		],
		maxFileSizeMB: 20,
		maxDurationSeconds: 25 * 60 // 25 minutes
	};

	private client: GPT4oClient;

	constructor(apiKey: string, model: string, dictionaryCorrector?: DictionaryCorrector) {
		super();
		this.modelId = model;
		// Map model names for display
		const modelNameMap: Record<string, string> = {
			'gpt-4o-transcribe': 'GPT-4o Transcribe',
			'gpt-4o-mini-transcribe': 'GPT-4o Mini Transcribe'
		};
		this.modelName = modelNameMap[model] || model;

		// Dictionary corrector is now handled at the controller level
		this.dictionaryCorrector = dictionaryCorrector;

		this.client = new GPT4oClient(apiKey, model);
		this.logger = Logger.getLogger('GPT4oTranscriptionService');
		this.logger.debug('GPT4oTranscriptionService initialized', {
			model: this.modelId,
			modelName: this.modelName,
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
			errors.push(`Chunk size ${chunkSizeMB.toFixed(1)}MB exceeds GPT-4o limit of ${this.capabilities.maxFileSizeMB}MB`);
		}

		// Check duration
		const duration = request.chunk.endTime - request.chunk.startTime;
		if (duration > this.capabilities.maxDurationSeconds) {
			this.logger.warn('Chunk duration exceeds limit', {
				duration,
				limit: this.capabilities.maxDurationSeconds
			});
			errors.push(`Chunk duration ${duration}s exceeds GPT-4o limit of ${this.capabilities.maxDurationSeconds}s`);
		}

		// Check language support
		if (request.options.language && request.options.language !== 'auto') {
			if (!this.isLanguageSupported(request.options.language)) {
				warnings.push(`Language '${request.options.language}' may have limited support in GPT-4o`);
			}
		}

		// Warning for multilingual content
		if (request.options.language === 'auto') {
			warnings.push('GPT-4o may transliterate non-native words to katakana in Japanese mode. Consider using Whisper for multilingual content.');
		}

		// Estimate cost
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
		this.logger.debug('Starting GPT-4o transcription', {
			chunkId: chunk.id,
			chunkDuration: `${(chunk.endTime - chunk.startTime).toFixed(2)}s`,
			language: options.language,
			model: this.modelId
		});

		// GPT-4o specific options (mainly previousContext)
		const gpt4oOptions: ModelSpecificOptions = {
			gpt4o: {
				responseFormat: 'json',
				...modelOptions?.gpt4o
			}
		};

		try {
			const result = await this.client.transcribe(chunk, options, gpt4oOptions);

			const transcriptionTime = performance.now() - startTime;
			this.logger.info('GPT-4o transcription completed', {
				chunkId: chunk.id,
				transcriptionTime: `${transcriptionTime.toFixed(2)}ms`,
				resultLength: result.text.length,
				detectedLanguage: result.language
			});

			return result;
		} catch (error) {
			this.logger.error('GPT-4o transcription failed', {
				chunkId: chunk.id,
				model: this.modelId,
				error
			});
			throw error;
		}
	}

	/**
	 * Test API connection
	 */
	async testConnection(apiKey: string): Promise<boolean> {
		this.logger.debug('Testing GPT-4o API connection', { model: this.modelId });
		try {
			const testClient = new GPT4oClient(apiKey, this.modelId);
			const result = await testClient.testConnection();
			this.logger.info('GPT-4o connection test completed', {
				success: result,
				model: this.modelId
			});
			return result;
		} catch (error) {
			this.logger.error('GPT-4o connection test failed', {
				model: this.modelId,
				error
			});
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
	 * Get optimal chunk duration for GPT-4o
	 */
	getOptimalChunkDuration(): number {
		const config = getModelConfig(this.modelId);
		return config.chunkDurationSeconds;
	}

	/**
	 * Check if this is the mini model
	 */
	isMiniModel(): boolean {
		return this.modelId === 'gpt-4o-mini-transcribe';
	}

}
