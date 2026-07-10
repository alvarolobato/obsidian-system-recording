/**
 * OpenAI Configuration Index
 * Central export point for all OpenAI API configurations
 */

// Whisper API (Traditional transcription)
export * from './WhisperConfig';

// GPT-4o Transcribe API (New transcription models)
export * from './GPT4oTranscribeConfig';

// Realtime API (WebSocket streaming)
export * from './RealtimeApiConfig';

// Post-processing configuration
export * from './PostProcessingConfig';

// Common types and utilities
export interface OpenAIModel {
	id: string;
	type: 'transcription' | 'chat' | 'realtime';
	displayName: string;
	endpoint: string;
	costPerMinute?: number;
}

/**
 * Get all available OpenAI models
 */
export function getAvailableModels(): OpenAIModel[] {
	return [
		// Transcription models
		{
			id: 'whisper-1',
			type: 'transcription',
			displayName: 'Whisper v1',
			endpoint: 'https://api.openai.com/v1/audio/transcriptions',
			costPerMinute: 0.006
		},
		{
			id: 'gpt-4o-transcribe',
			type: 'transcription',
			displayName: 'GPT-4o Transcribe',
			endpoint: 'https://api.openai.com/v1/audio/transcriptions',
			costPerMinute: 0.006
		},
		{
			id: 'gpt-4o-mini-transcribe',
			type: 'transcription',
			displayName: 'GPT-4o Mini Transcribe',
			endpoint: 'https://api.openai.com/v1/audio/transcriptions',
			costPerMinute: 0.003
		}
	];
}

/**
 * Determine which OpenAI configuration to use based on model ID
 */
export function getOpenAIModelConfig(modelId: string) {
	switch (modelId) {
	case 'whisper-1':
		return { type: 'whisper', module: 'whisper.config' };
	case 'gpt-4o-transcribe':
	case 'gpt-4o-mini-transcribe':
		return { type: 'gpt4o-transcribe', module: 'gpt4o-transcribe.config' };
	default:
		throw new Error(`Unknown model: ${modelId}`);
	}
}

/**
 * Common request configuration
 */
export interface RequestConfig {
	timeout: number;
	maxRetries: number;
	retryDelayMs: number;
	maxRetryDelayMs: number;
}

export const DEFAULT_REQUEST_CONFIG: RequestConfig = {
	timeout: 300000, // 5 minutes
	maxRetries: 3,
	retryDelayMs: 1000,
	maxRetryDelayMs: 30000
};