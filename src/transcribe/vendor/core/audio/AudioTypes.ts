/**
 * Core audio processing types
 * Defines the common data structures used throughout the audio pipeline
 */

/**
 * Represents raw audio input from various sources
 */
export interface AudioInput {
	/** Raw audio data as ArrayBuffer */
	data: ArrayBuffer;
	/** Original file name */
	fileName: string;
	/** File extension (mp3, wav, etc.) */
	extension: string;
	/** File type (audio/mpeg, audio/wav, etc.) */
	fileType?: string;
	/** File size in bytes */
	size: number;
}

/**
 * Processed audio ready for chunking
 * Standardized format: 16kHz, 16-bit, mono PCM
 */
export interface ProcessedAudio {
	/** PCM audio data */
	pcmData: Float32Array;
	/** Sample rate (should be 16000) */
	sampleRate: number;
	/** Duration in seconds */
	duration: number;
	/** Number of channels (should be 1 for mono) */
	channels: number;
	/** Original file info */
	source: AudioInput;
}

/**
 * Audio chunk for transcription
 * Represents a segment of audio with timing information
 */
export interface AudioChunk {
	/** Unique chunk identifier */
	id: number;
	/** Audio data as WAV format ArrayBuffer */
	data: ArrayBuffer;
	/** Start time in seconds from original audio */
	startTime: number;
	/** End time in seconds from original audio */
	endTime: number;
	/** Whether this chunk has overlap with previous */
	hasOverlap: boolean;
	/** Overlap duration in seconds */
	overlapDuration: number;
}

/**
 * Audio processing configuration
 */
export interface AudioProcessingConfig {
	/** Target sample rate for all audio (16kHz for APIs) */
	targetSampleRate: number;
	/** Target bit depth (16 for APIs) */
	targetBitDepth: number;
	/** Target channels (1 for mono) */
	targetChannels: number;
	/** Whether to apply VAD preprocessing */
	enableVAD: boolean;
	/** Audio format */
	format?: string;
	/** Sample rate */
	sampleRate?: number;
	/** Number of channels */
	channels?: number;
	/** VAD configuration if enabled */
	vadConfig?: {
		processor: 'webrtc' | 'silero' | 'auto';
		sensitivity: number;
		minSpeechDuration: number;
		maxSilenceDuration: number;
	};
}

/**
 * Audio validation result
 */
export interface AudioValidationResult {
	/** Whether the audio is valid for processing */
	isValid: boolean;
	/** Error message if invalid */
	error?: string;
	/** Warnings that don't prevent processing */
	warnings?: string[];
	/** Detected audio properties */
	properties?: {
		format: string;
		duration: number;
		sampleRate: number;
		channels: number;
		bitrate?: number;
	};
}