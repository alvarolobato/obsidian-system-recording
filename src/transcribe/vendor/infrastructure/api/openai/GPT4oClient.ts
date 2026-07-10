/**
 * OpenAI GPT-4o Audio API client implementation
 * Handles GPT-4o-specific API calls with context preservation
 */

import {
	GPT4O_TRANSCRIBE_CONFIG,
	buildGPT4oTranscribeRequest
} from '../../../config/openai/GPT4oTranscribeConfig';
import { DEFAULT_REQUEST_CONFIG } from '../../../config/openai/index';
import { Logger } from '../../../utils/Logger';
import { ApiClient } from '../ApiClient';
import { getTranscribeBaseUrl, getTranscribeModelOverride } from '../../../../endpointConfig';

import { extractTranscriptFromTagWrapper } from './TranscriptTagExtractor';

import type {
	GPT4oTranscribeParams,
	GPT4oTranscribeRequestPayload
} from '../../../config/openai/GPT4oTranscribeConfig';
import type { AudioChunk } from '../../../core/audio/AudioTypes';
import type {
	TranscriptionResult,
	TranscriptionOptions,
	ModelSpecificOptions
} from '../../../core/transcription/TranscriptionTypes';

interface GPT4oResponse {
	text: string;
	// GPT-4o doesn't provide detailed segment info in basic JSON format
}

export class GPT4oClient extends ApiClient {
	private readonly supportedModels = Object.keys(GPT4O_TRANSCRIBE_CONFIG.models);

	// Model name mapping
	private readonly modelMapping: Record<string, string> = {
		'gpt-4o-transcribe': 'gpt-4o-transcribe',
		'gpt-4o-mini-transcribe': 'gpt-4o-mini-transcribe'
	};

	constructor(apiKey: string, private model: string) {
		// MEETING-COPILOT PATCH: base URL from the owned endpoint seam. See VENDOR.md.
		const baseUrl = getTranscribeBaseUrl();
		super({
			baseUrl, // Extract base URL
			apiKey,
			timeout: DEFAULT_REQUEST_CONFIG.timeout,
			maxRetries: 0,
			retryDelay: DEFAULT_REQUEST_CONFIG.retryDelayMs
		});

		// Map model name if needed
		this.model = this.modelMapping[model] || model;

		if (!this.supportedModels.includes(this.model)) {
			throw new Error(`Unsupported GPT-4o model: ${model} (mapped to: ${this.model})`);
		}

		this.logger = Logger.getLogger('GPT4oClient');
	}

	/**
	 * Transcribe audio chunk using GPT-4o API
	 */
	async transcribe(
		chunk: AudioChunk,
		options: TranscriptionOptions,
		modelOptions?: ModelSpecificOptions
	): Promise<TranscriptionResult> {
		const formData = new FormData();

		// Create file from chunk data
		const fileName = `chunk_${chunk.id}.wav`;
		const file = new File([chunk.data], fileName, { type: 'audio/wav' });
		formData.append('file', file);

		// Use custom prompt if provided, otherwise let buildGPT4oTranscribeRequest handle it
		const customPrompt = modelOptions?.gpt4o?.customPrompt;


			// Build request parameters using the new config
			const requestInput: Partial<GPT4oTranscribeParams> = {
				model: this.model as 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe',
				response_format: 'json', // GPT-4o only supports json/text
				language: options.language === 'auto' ? 'auto' : options.language,
				stream: false // No streaming for now
			};
			if (customPrompt) {
				requestInput.prompt = customPrompt;
			}
			const previousContext = modelOptions?.gpt4o?.previousContext;
			if (previousContext) {
				requestInput.previousContext = previousContext;
			}

			const requestParams = buildGPT4oTranscribeRequest(requestInput, chunk.id === 0 && !previousContext);

			// MEETING-COPILOT PATCH: send a custom deployment name when set. See VENDOR.md.
			const modelOverride = getTranscribeModelOverride();
			if (modelOverride) {
				(requestParams as { model: string }).model = modelOverride;
			}

		// Append all parameters to FormData
		const paramEntries = Object.entries(requestParams) as Array<
			[keyof GPT4oTranscribeRequestPayload, GPT4oTranscribeRequestPayload[keyof GPT4oTranscribeRequestPayload]]
		>;
		paramEntries.forEach(([key, value]) => {
			if (value === undefined) {
				return;
			}
			const serialized = Array.isArray(value) ? value.join(',') : String(value);
			formData.append(key, serialized);
		});

		try {
			const startTime = performance.now();
			this.logger.debug('Sending request to GPT-4o API', {
				chunkId: chunk.id,
				model: this.model,
				hasCustomPrompt: Boolean(customPrompt)
			});

			const response = await this.post<GPT4oResponse>(
				'/audio/transcriptions',
				formData,
				{},
				options.signal
			);

			const elapsedTime = performance.now() - startTime;
			this.logger.debug('GPT-4o API response received', {
				chunkId: chunk.id,
				elapsedTime: `${elapsedTime.toFixed(2)}ms`
			});

			return this.parseResponse(response, chunk);

		} catch (error) {
			this.logger.error('GPT-4o transcription failed', {
				chunkId: chunk.id,
				error: error instanceof Error ? error.message : 'Unknown error'
			});

			return {
				id: chunk.id,
				text: '',
				startTime: chunk.startTime,
				endTime: chunk.endTime,
				success: false,
				error: error instanceof Error ? error.message : 'Unknown error'
			};
		}
	}


	/**
	 * Parse GPT-4o API response
	 */
			private parseResponse(response: GPT4oResponse, chunk: AudioChunk): TranscriptionResult {
				let text = response.text || '';

				const extraction = extractTranscriptFromTagWrapper(text);
				text = extraction.extractedText;

		const result = {
			id: chunk.id,
			text: text,
			startTime: chunk.startTime,
			endTime: chunk.endTime,
			success: true
			// GPT-4o doesn't provide segments in basic JSON format
		};

			this.logger.debug('GPT-4o response parsed', {
				chunkId: chunk.id,
				textLength: result.text.length,
				hasTranscriptTags: extraction.hadTranscriptTags,
				transcriptTagMode: extraction.mode
			});

		return result;
	}

	/**
	 * Test connection to OpenAI API
	 */
	async testConnection(): Promise<boolean> {
		try {
			await this.get('/models');
			return true;
		} catch (error) {
			this.logger.error('GPT-4o API connection test failed', error);
			return false;
		}
	}

	/**
	 * Get maximum file size in bytes
	 */
	static getMaxFileSize(): number {
		// Use configured value (25MB for GPT-4o Transcribe)
		return GPT4O_TRANSCRIBE_CONFIG.limitations.maxFileSizeMB * 1024 * 1024;
	}

	/**
	 * Get maximum audio duration in seconds
	 */
	static getMaxDuration(): number {
		return GPT4O_TRANSCRIBE_CONFIG.limitations.maxDurationMinutes * 60;
	}
}
