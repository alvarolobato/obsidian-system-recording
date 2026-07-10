/**
 * Core transcription types
 * Defines the common data structures for transcription results and options
 */

import type { AudioChunk } from '../audio/AudioTypes';

/**
 * Transcription result from any AI model
 */
export interface TranscriptionResult {
	/** Unique identifier for this result */
	id: number;
	/** Transcribed text */
	text: string;
	/** Start time in seconds (for chunks) */
	startTime: number;
	/** End time in seconds (for chunks) */
	endTime: number;
	/** Whether transcription was successful */
	success: boolean;
	/** Error message if failed */
	error?: string;
	/** Detailed segments with timestamps (if available) */
	segments?: TranscriptionSegment[];
	/** Confidence score (if available) */
	confidence?: number;
	/** Language detected (if available) */
	language?: string;
}

/**
 * Detailed transcription segment with word-level timestamps
 */
export interface TranscriptionSegment {
	/** Segment text */
	text: string;
	/** Start time in seconds */
	start: number;
	/** End time in seconds */
	end: number;
	/** Word-level timestamps (if available) */
	words?: Array<{
		word: string;
		start: number;
		end: number;
		confidence?: number;
	}>;
}

/**
 * Transcription options common to all models
 */
export interface TranscriptionOptions {
	/** Target language code (ja, en, zh, etc.) or 'auto' */
	language: string;
	/** Request detailed timestamps */
	timestamps?: boolean;
	/** Abort signal for cancellation */
	signal?: AbortSignal;
}

/**
 * Model-specific transcription options
 */
export interface ModelSpecificOptions {
	/** Options specific to Whisper model */
	whisper?: {
		/** Response format */
		responseFormat: 'json' | 'verbose_json' | 'text';
		/** Timestamp granularities */
		timestampGranularities?: ('word' | 'segment')[];
		/** Previous context for continuation */
		previousContext?: string;
		/** Custom prompt to override default */
		customPrompt?: string;
	};
	/** Options specific to GPT-4o models */
	gpt4o?: {
		/** Previous context for continuation */
		previousContext?: string;
		/** Response format (only json supported) */
		responseFormat: 'json';
		/** Custom prompt to override default */
		customPrompt?: string;
	};
}

/**
 * Complete transcription request
 */
export interface TranscriptionRequest {
	/** Audio chunk to transcribe */
	chunk: AudioChunk;
	/** Common transcription options */
	options: TranscriptionOptions;
	/** Model-specific options */
	modelOptions?: ModelSpecificOptions;
}

/**
 * Transcription validation result
 */
export interface TranscriptionValidation {
	/** Whether the request is valid */
	isValid: boolean;
	/** Validation errors */
	errors: string[];
	/** Validation warnings */
	warnings: string[];
	/** Estimated cost (if calculable) */
	estimatedCost?: {
		amount: number;
		currency: string;
		breakdown?: {
			model: string;
			duration: number;
			rate: number;
		};
	};
}

/**
 * Transcription progress information
 */
export interface TranscriptionProgress {
	/** Current chunk being processed */
	currentChunk: number;
	/** Total number of chunks */
	totalChunks: number;
	/** Percentage complete (0-100) */
	percentage: number;
	/** Current operation description */
	operation: string;
	/** Estimated time remaining in seconds */
	estimatedTimeRemaining?: number;
	/** Whether the operation can be cancelled */
	cancellable: boolean;
}

/**
 * Meta information for transcription
 */
export interface TranscriptionMetaInfo {
	/** Raw meta content provided by user */
	rawContent: string;
	/** Language of the transcription */
	language: string;
	/** Whether to enable post-processing */
	enablePostProcessing: boolean;
}
