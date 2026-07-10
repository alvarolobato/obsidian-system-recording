/**
 * OpenAI Whisper API client implementation
 * Handles Whisper-specific API calls and response parsing
 */

import { DEFAULT_REQUEST_CONFIG } from '../../../config/openai/index';
import {
	WHISPER_CONFIG,
	buildWhisperRequest
} from '../../../config/openai/WhisperConfig';
import { Logger } from '../../../utils/Logger';
import { ApiClient } from '../ApiClient';
import { getTranscribeBaseUrl, getTranscribeModelOverride } from '../../../../endpointConfig';

import type {
	WhisperTranscriptionParams,
	WhisperRequestPayload
} from '../../../config/openai/WhisperConfig';
import type { AudioChunk } from '../../../core/audio/AudioTypes';
import type {
	TranscriptionResult,
	TranscriptionSegment,
	TranscriptionOptions,
	ModelSpecificOptions
} from '../../../core/transcription/TranscriptionTypes';


interface WhisperResponse {
	text: string;
	language?: string;
	duration?: number;
	segments?: Array<{
		id: number;
		text: string;
		start: number;
		end: number;
		words?: Array<{
			word: string;
			start: number;
			end: number;
		}>;
	}>;
}

export class WhisperClient extends ApiClient {

	constructor(apiKey: string) {
		// MEETING-COPILOT PATCH: base URL comes from the owned endpoint seam
		// instead of the hardcoded WHISPER_CONFIG constant. See VENDOR.md.
		const baseUrl = getTranscribeBaseUrl();
		super({
			baseUrl, // Extract base URL
			apiKey,
			timeout: 60000, // 60 seconds for Whisper
			maxRetries: DEFAULT_REQUEST_CONFIG.maxRetries,
			retryDelay: DEFAULT_REQUEST_CONFIG.retryDelayMs
		});

		this.logger = Logger.getLogger('WhisperClient');
	}

	/**
	 * Transcribe audio chunk using Whisper API
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

			// Build request parameters using the new config
			const requestInput: Partial<WhisperTranscriptionParams> = {
				response_format: modelOptions?.whisper?.responseFormat || WHISPER_CONFIG.defaults.response_format
			};
			if (options.language !== 'auto') {
				requestInput.language = options.language;
			}
			const granularities = modelOptions?.whisper?.timestampGranularities;
			if (granularities && granularities.length > 0) {
				requestInput.timestamp_granularities = granularities;
			}

			const requestParams = buildWhisperRequest(requestInput, chunk.id === 0); // isFirstChunk

			// MEETING-COPILOT PATCH: send a custom deployment name when set
			// (e.g. LiteLLM's `llm-gateway/whisper`). See VENDOR.md.
			const modelOverride = getTranscribeModelOverride();
			if (modelOverride) {
				(requestParams as { model: string }).model = modelOverride;
			}


		// Append all parameters to FormData
		const requestEntries = Object.entries(requestParams) as Array<
			[keyof WhisperRequestPayload, WhisperRequestPayload[keyof WhisperRequestPayload]]
		>;
		requestEntries.forEach(([key, value]) => {
			if (value === undefined) {
				return;
			}

			if (key === 'timestamp_granularities' && Array.isArray(value)) {
				// OpenAI expects each array element as a separate form field with brackets
				value.forEach(item => {
					formData.append('timestamp_granularities[]', item);
				});
				return;
			}

			if (Array.isArray(value)) {
				// For other arrays, use JSON string format
				formData.append(key, JSON.stringify(value));
				return;
			}

			formData.append(key, String(value));
		});

		try {
			const startTime = performance.now();
			this.logger.trace('Sending request to Whisper API', {
				chunkId: chunk.id,
				requestParams: {
					model: requestParams.model,
					response_format: requestParams.response_format,
					timestamp_granularities: requestParams.timestamp_granularities,
					language: requestParams.language
				}
			});

			const response = await this.post<WhisperResponse | string>(
				'/audio/transcriptions',
				formData,
				{},
				options.signal
			);

			this.logger.debug('Whisper API response type', {
				chunkId: chunk.id,
				responseType: typeof response,
				hasSegments: typeof response === 'object' && 'segments' in response,
				segmentsCount: typeof response === 'object' && response.segments?.length,
				// Log first few segments for debugging
				sampleSegments: typeof response === 'object' && response.segments
					? response.segments.slice(0, 2).map(s => ({ start: s.start, end: s.end, textLength: s.text.length }))
					: null
			});

			const result = this.parseResponse(response, chunk);

			const elapsedTime = performance.now() - startTime;
			this.logger.debug('Whisper transcription completed', {
				chunkId: chunk.id,
				elapsedTime: `${elapsedTime.toFixed(2)}ms`,
				textLength: result.text.length,
				hasSegments: Boolean(result.segments),
				segmentsCount: result.segments?.length
			});

			return result;

		} catch (error) {
			this.logger.error('Whisper transcription failed', {
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
	 * Parse Whisper API response
	 */
		private parseResponse(response: WhisperResponse | string, chunk: AudioChunk): TranscriptionResult {
			// Handle text-only response format
			if (typeof response === 'string') {
				return {
					id: chunk.id,
					text: response,
					startTime: chunk.startTime,
					endTime: chunk.endTime,
					success: true
				};
			}

			// Handle verbose_json response format
			// Adjust timestamps based on chunk offset
			const segments = response.segments?.flatMap(segment => {
				const mapped: TranscriptionSegment = {
					text: segment.text,
					start: segment.start + chunk.startTime,
					end: segment.end + chunk.startTime
				};
				if (segment.words) {
					mapped.words = segment.words.map(word => ({
						word: word.word,
						start: word.start + chunk.startTime,
						end: word.end + chunk.startTime
					}));
				}
				return [mapped];
			});

			const result: TranscriptionResult = {
				id: chunk.id,
				text: response.text || '',
				startTime: chunk.startTime,
				endTime: chunk.endTime,
				success: true
			};
			if (segments && segments.length > 0) {
				result.segments = segments;
			}
			if (response.language) {
				result.language = response.language;
			}

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
			this.logger.error('Whisper API connection test failed', error);
			return false;
		}
	}

	/**
	 * Get supported audio formats
	 */
	static getSupportedFormats(): string[] {
		return WHISPER_CONFIG.limitations.supportedFormats;
	}

	/**
	 * Get maximum file size in bytes
	 */
	static getMaxFileSize(): number {
		// Use configured value (25MB for Whisper)
		return WHISPER_CONFIG.limitations.maxFileSizeMB * 1024 * 1024;
	}
}
