/**
 * OpenAI Whisper API Configuration
 *
 * Reference: https://platform.openai.com/docs/guides/speech-to-text
 */

export interface WhisperTranscriptionParams {
	/** Model to use (only whisper-1 available) */
	model: 'whisper-1';

	/** The audio file to transcribe */
	file: File | Blob;

	/** Response format */
	response_format?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';

	/** Language of the audio (ISO-639-1) */
	language?: string;

	/** Sampling temperature (0.0-1.0) */
	temperature?: number;

	/** Timestamp granularities (requires verbose_json format) */
	timestamp_granularities?: ('word' | 'segment')[];

	/** Optional prompt to guide the model (max 224 tokens) */
	prompt?: string;
}

export interface WhisperTranslationParams {
	/** Model to use (only whisper-1 available) */
	model: 'whisper-1';

	/** The audio file to translate */
	file: File | Blob;

	/** Response format */
	response_format?: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';

	/** Sampling temperature (0.0-1.0) */
	temperature?: number;
}

export interface WhisperConfig {
	endpoint: {
		transcriptions: string;
		translations: string;
	};

	limitations: {
		maxFileSizeMB: number;
		supportedFormats: string[];
		maxDurationMinutes: number;
		costPerMinute: number;
	};

	defaults: {
		response_format: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt';
		temperature: number;
	};

	prompts: {
		firstChunk: Record<string, string>;
		continuation: Record<string, string>;
	};
}

export const WHISPER_CONFIG: WhisperConfig = {
	endpoint: {
		transcriptions: 'https://api.openai.com/v1/audio/transcriptions',
		translations: 'https://api.openai.com/v1/audio/translations'
	},

	limitations: {
		maxFileSizeMB: 25, // OpenAI official limit
		supportedFormats: ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'],
		maxDurationMinutes: 30,
		costPerMinute: 0.006
	},

	defaults: {
		response_format: 'verbose_json', // verbose_jsonでタイムスタンプ情報を取得
		temperature: 0.0
	},

	prompts: {
		// 初回チャンク用のプロンプト（最小限に留める）
		firstChunk: {
			ja: '', // 空にして自動検出に任せる
			en: '',
			zh: '',
			ko: '',
			auto: '' // 自動言語検出
		},
		// 継続チャンク用 - 前チャンクの最後の文を使用（実装で動的に設定）
		continuation: {
			ja: '', // 動的に前チャンクの最後の文を設定
			en: '',
			zh: '',
			ko: '',
			auto: '' // 自動言語検出
		}
	}
};

export interface WhisperRequestPayload {
	model: string;
	response_format: string;
	temperature: number;
	language?: string;
	prompt?: string;
	timestamp_granularities?: ('word' | 'segment')[];
}

/**
 * Build Whisper API request parameters
 */
export function buildWhisperRequest(
	params: Partial<WhisperTranscriptionParams>,
	_isFirstChunk: boolean = true
): WhisperRequestPayload {
	const config = WHISPER_CONFIG;
	const result: WhisperRequestPayload = {
		model: 'whisper-1',
		response_format: params.response_format || config.defaults.response_format,
		temperature: config.defaults.temperature
	};

	// Required parameters
	// Optional parameters (but always include response_format for clarity)
	// Always use the fixed temperature from config
	// Always include language parameter if specified (not 'auto')
	if (params.language && params.language !== 'auto') {
		result.language = params.language;
	}

	// Include prompt if provided
	if (params.prompt?.trim()) {
		result.prompt = params.prompt;
	}

	// Timestamp granularities (only valid with verbose_json)
	const responseFormat = params.response_format || config.defaults.response_format;
	if (params.timestamp_granularities && responseFormat === 'verbose_json') {
		// Use provided timestamp granularities
		result.timestamp_granularities = params.timestamp_granularities;
	}
	// Note: We don't set default timestamp_granularities here anymore
	// The caller (WhisperTranscriptionService) should explicitly set this based on the model

	return result;
}

/**
 * Validate file for Whisper API
 */
export function validateWhisperFile(
	file: File | { size: number; name: string },
	duration?: number
): { valid: boolean; error?: string } {
	const config = WHISPER_CONFIG;

	// Check file size
	if (file.size > config.limitations.maxFileSizeMB * 1024 * 1024) {
		return {
			valid: false,
			error: `File size (${(file.size / 1024 / 1024).toFixed(1)}MB) exceeds Whisper limit of ${config.limitations.maxFileSizeMB}MB`
		};
	}

	// Check file format
	const extension = file.name.split('.').pop()?.toLowerCase() || '';
	if (!config.limitations.supportedFormats.includes(extension)) {
		return {
			valid: false,
			error: `Format '${extension}' not supported. Supported: ${config.limitations.supportedFormats.join(', ')}`
		};
	}

	// Check duration if provided
	if (duration && duration > config.limitations.maxDurationMinutes * 60) {
		return {
			valid: false,
			error: `Duration (${(duration / 60).toFixed(1)}min) exceeds limit of ${config.limitations.maxDurationMinutes}min`
		};
	}

	return { valid: true };
}
