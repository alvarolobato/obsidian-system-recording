/**
 * Model Processing Configuration
 * Audio processing and chunking parameters for different AI models
 *
 * Based on OpenAI API limitations:
 * - All models: 25MB file size limit
 * - Whisper: Optimized for shorter chunks, supports timestamps and multiple output formats
 * - GPT-4o/mini: Supports longer audio (up to 25 min), json/text output only
 *
 * Chunk sizes are optimized for:
 * - Whisper: Shorter chunks (25-30s) for better accuracy and timestamp precision
 * - GPT-4o: Longer chunks (5-6 min) for better context understanding
 * - GPT-4o-mini: Medium chunks (4-5 min) balancing accuracy and context
 *
 * This file contains:
 * - Model-specific processing settings (chunk duration, file size limits, etc.)
 * - Audio chunking and overlap configuration
 * - Concurrent processing limits
 * - Processing optimization settings
*/
import { Logger } from '../utils/Logger';

import { AUDIO_CONSTANTS } from './constants';

/**
 * Configuration for a specific AI model's audio processing parameters
 */
export interface ModelConfig {
	/** Target chunk duration in seconds (VAD will adjust within ±variance range) */
	chunkDurationSeconds: number;
	/** Maximum file size in MB */
	maxFileSizeMB: number;
	/** Maximum duration in seconds (Infinity for no limit) */
	maxDurationSeconds: number;
	/** Maximum concurrent chunks for parallel processing */
	maxConcurrentChunks: number;
	/** Rate limiting delay between batches in milliseconds */
	rateLimitDelayMs: number;
	/** Context window size for sequential processing (characters) */
	contextWindowSize: number;
	/** Model-specific VAD chunking parameters (required) */
	vadChunking: {
		/** Overlap duration between chunks in seconds */
		overlapDurationSeconds: number;
		/** Variance in seconds from chunkDurationSeconds (±) for VAD flexibility */
		chunkDurationVariance: number;
		/** Minimum silence duration for chunk split in seconds */
		minSilenceForSplit: number;
		/** Extra time after preferred duration to force split on short silence */
		forceSplitAfterExtra: number;
		/** Minimum chunk size in seconds (to avoid too small chunks) */
		minChunkSize: number;
		/** Enable boundary optimization for natural speech breaks */
		optimizeBoundaries: boolean;
	};
	/** Merging and deduplication settings */
	merging: {
		/** Time window for duplicate text detection (seconds) - for Whisper */
		duplicateWindowSeconds?: number;
		/** Minimum characters to consider as duplicate */
		minMatchLength?: number;
		/** Overlap threshold for segment merging (0-1) */
		overlapThreshold?: number;
		/** Estimated characters per second of speech */
		estimatedCharsPerSecond?: number;
		/** Fuzzy match similarity threshold (0-1) for overlap detection */
		fuzzyMatchSimilarity?: number;
		/** Use N-gram based screening for faster fuzzy matching */
		useNGramScreening?: boolean;
		/** N-gram size for fuzzy match screening */
		nGramSize?: number;
		/** Configuration for duplicate removal in merged text */
		duplicateRemoval?: {
			/** Enable duplicate removal after merging */
			enabled: boolean;
			/** Minimum length for duplicate detection */
			minDuplicateLength: number;
			/** Similarity threshold for duplicate detection (0-1) */
			duplicateSimilarityThreshold: number;
			/** Use fuzzy matching for duplicate detection */
			useFuzzyMatching: boolean;
		};
		/** Overlap detection configuration for chunk merging */
		overlapDetection?: {
			/** Minimum overlap length to search for (characters) */
			minOverlapLength: number;
			/** Maximum overlap length to search for (characters) */
			maxOverlapLength: number;
			/** Search range in next chunk (characters) */
			searchRangeInNext: number;
			/** Step size when reducing candidate length (characters) */
			candidateStepSize: number;
			/** Similarity threshold for n-gram matching (0-1) */
			similarityThreshold: number;
			/** Skip ratio after finding a match (0-1) to avoid overlapping matches */
			matchSkipRatio?: number;
		};
	};
	/** Pricing configuration */
	pricing: {
		/** Cost per minute in USD */
		costPerMinute: number;
		/** Currency code */
		currency: string;
	};
}

export interface TranscriptionConfig {
	models: {
		whisper: ModelConfig;
		whisperTs: ModelConfig;
		gpt4o: ModelConfig;
		gpt4oMini: ModelConfig;
	};

	/** Default VAD settings */
	vad: {
		sensitivity: number;
		minSpeechDuration: number;
		maxSilenceDuration: number;
		speechPadding: number;
	};

	/** Audio processing settings */
	audio: {
		targetSampleRate: number;
		targetBitDepth: number;
		targetChannels: number;
	};
}

/**
 * Default transcription configuration
 * These values can be overridden in settings or environment
 */
export const DEFAULT_TRANSCRIPTION_CONFIG: TranscriptionConfig = {
	models: {
		whisper: {
			chunkDurationSeconds: 25, // Target: 25 seconds (VAD adjusts within 20-30s)
			maxFileSizeMB: 25, // OpenAI API file size limit: 25MB
			maxDurationSeconds: Infinity, // Whisper has no duration limit (only file size limit)
			maxConcurrentChunks: 2, // Process 2 chunks in parallel
			rateLimitDelayMs: 3000, // 3 seconds between batches
			contextWindowSize: 0, // Whisper doesn't use context (uses timestamps instead)
			vadChunking: {
				overlapDurationSeconds: 5, // 5 seconds overlap between chunks
				chunkDurationVariance: 5, // ±5 seconds (20-30s range)
				minSilenceForSplit: 0.5, // 500ms of silence
				forceSplitAfterExtra: 3, // 3 seconds extra before forced split
				minChunkSize: 0.1, // 100ms minimum chunk size to avoid API errors
				optimizeBoundaries: true // Enable boundary optimization for natural breaks
			},
			merging: {
				duplicateWindowSeconds: 30, // Time window for duplicate text detection
				minMatchLength: 20, // Minimum characters to consider as duplicate
				overlapThreshold: 0.5, // 50% overlap threshold for segment merging
				estimatedCharsPerSecond: 15, // Estimated characters per second of speech
				fuzzyMatchSimilarity: 0.85, // 85% similarity threshold for fuzzy matching
				useNGramScreening: true, // Enable fast N-gram screening
				nGramSize: 3, // Use trigrams for screening
				duplicateRemoval: {
					enabled: false, // Disabled - post-process cleaning handles deduplication
					minDuplicateLength: 15, // Lower threshold for Whisper's short chunk duplicates
					duplicateSimilarityThreshold: 0.75, // Using text normalization for better similarity detection
					useFuzzyMatching: true // Use fuzzy matching for duplicate detection
				}
			},
			pricing: {
				costPerMinute: 0.006, // $0.006 per minute for Whisper
				currency: 'USD'
			}
		},

		whisperTs: {
			chunkDurationSeconds: 25, // Target: 25 seconds (VAD adjusts within 20-30s)
			maxFileSizeMB: 25, // OpenAI API file size limit: 25MB
			maxDurationSeconds: Infinity, // Whisper has no duration limit (only file size limit)
			maxConcurrentChunks: 2, // Process 2 chunks in parallel
			rateLimitDelayMs: 3000, // 3 seconds between batches
			contextWindowSize: 0, // Whisper doesn't use context (uses timestamps instead)
			vadChunking: {
				overlapDurationSeconds: 5, // 5 seconds overlap between chunks
				chunkDurationVariance: 5, // ±5 seconds (20-30s range)
				minSilenceForSplit: 0.5, // 500ms of silence
				forceSplitAfterExtra: 3, // 3 seconds extra before forced split
				minChunkSize: 0.1, // 100ms minimum chunk size to avoid API errors
				optimizeBoundaries: true // Enable boundary optimization for natural breaks
			},
			merging: {
				duplicateWindowSeconds: 30, // Time window for duplicate text detection
				minMatchLength: 20, // Minimum characters to consider as duplicate
				overlapThreshold: 0.5, // 50% overlap threshold for segment merging
				estimatedCharsPerSecond: 15, // Estimated characters per second of speech
				fuzzyMatchSimilarity: 0.85, // 85% similarity threshold for fuzzy matching
				useNGramScreening: true, // Enable fast N-gram screening
				nGramSize: 3, // Use trigrams for screening
				duplicateRemoval: {
					enabled: false, // Disabled - post-process cleaning handles deduplication
					minDuplicateLength: 15, // Lower threshold for Whisper's short chunk duplicates
					duplicateSimilarityThreshold: 0.75, // Using text normalization for better similarity detection
					useFuzzyMatching: true // Use fuzzy matching for duplicate detection
				}
			},
			pricing: {
				costPerMinute: 0.006, // $0.006 per minute for Whisper
				currency: 'USD'
			}
		},

		gpt4o: {
			chunkDurationSeconds: 300, // Target: 5 minutes (VAD adjusts within 4-6 min)
			maxFileSizeMB: 25, // GPT-4o limit is 25MB
			maxDurationSeconds: 25 * 60, // 25 minutes - OpenAI transcription API limit
			maxConcurrentChunks: 1, // Sequential processing only
			rateLimitDelayMs: 0, // No rate limiting for sequential processing
			// contextWindowSize should cover the entire overlap duration
			// 30 seconds overlap × 15 chars/second = 450 chars minimum
			contextWindowSize: 500, // Characters from previous chunk (covers 30s overlap + margin)
			vadChunking: {
				overlapDurationSeconds: 30, // 30 seconds overlap between chunks
				chunkDurationVariance: 60, // ±60 seconds (240-360s range)
				minSilenceForSplit: 1.0, // 1 second of silence (longer for natural breaks)
				forceSplitAfterExtra: 30, // 30 seconds extra before forced split
				minChunkSize: 0.1, // 100ms minimum chunk size to avoid API errors
				optimizeBoundaries: true // Enable boundary optimization for natural breaks
			},
			merging: {
				duplicateWindowSeconds: 30, // Default time window for duplicate text detection
				minMatchLength: 20, // Default minimum characters to consider as duplicate
				overlapThreshold: 0.5, // Default 50% overlap threshold
				estimatedCharsPerSecond: 15, // Default estimated characters per second
				fuzzyMatchSimilarity: 0.85, // 85% similarity threshold for fuzzy matching
				useNGramScreening: true, // Enable fast N-gram screening
				nGramSize: 3, // Use trigrams for screening
				duplicateRemoval: {
					enabled: false, // Disabled - handled by overlap removal + cleaning (avoids UI freezes)
					minDuplicateLength: 200, // Longer threshold to avoid false positives
					duplicateSimilarityThreshold: 0.95, // Require high similarity
					useFuzzyMatching: true // Use fuzzy matching for duplicate detection
				},
				overlapDetection: {
					minOverlapLength: 40, // Minimum 40 characters (handles larger transcription drift at boundaries)
					maxOverlapLength: 500, // Maximum 500 characters
					searchRangeInNext: 800, // Search early in next chunk (overlap should appear near the start)
					candidateStepSize: 10, // Finer scan to cover 40-150 char overlaps
					similarityThreshold: 0.78 // Allow small differences in transcription across chunks
				}
			},
			pricing: {
				costPerMinute: 0.006, // $0.006 per minute for GPT-4o
				currency: 'USD'
			}
			// Note: GPT-4o primarily uses contextWindowSize for continuity, but merging settings still apply for deduplication
		},

		gpt4oMini: {
			chunkDurationSeconds: 240, // Target: 4 minutes (VAD adjusts within 3-5 min)
			maxFileSizeMB: 25, // Same as GPT-4o (25MB limit)
			maxDurationSeconds: 25 * 60, // 25 minutes - OpenAI transcription API limit
			maxConcurrentChunks: 1, // Sequential processing only
			rateLimitDelayMs: 0, // No rate limiting for sequential processing
			// contextWindowSize should cover the entire overlap duration
			// 30 seconds overlap × 15 chars/second = 450 chars minimum
			contextWindowSize: 500, // Characters from previous chunk (covers 30s overlap + margin)
			vadChunking: {
				overlapDurationSeconds: 30, // 30 seconds overlap between chunks
				chunkDurationVariance: 60, // ±60 seconds (180-300s range)
				minSilenceForSplit: 0.8, // 800ms of silence
				forceSplitAfterExtra: 20, // 20 seconds extra before forced split
				minChunkSize: 0.1, // 100ms minimum chunk size to avoid API errors
				optimizeBoundaries: true // Enable boundary optimization for natural breaks
			},
			merging: {
				duplicateWindowSeconds: 30, // Default time window for duplicate text detection
				minMatchLength: 20, // Default minimum characters to consider as duplicate
				overlapThreshold: 0.5, // Default 50% overlap threshold
				estimatedCharsPerSecond: 15, // Default estimated characters per second
				fuzzyMatchSimilarity: 0.85, // 85% similarity threshold for fuzzy matching
				useNGramScreening: true, // Enable fast N-gram screening
				nGramSize: 3, // Use trigrams for screening
				duplicateRemoval: {
					enabled: false, // Disabled - handled by overlap removal + cleaning (avoids UI freezes)
					minDuplicateLength: 200, // Longer threshold to avoid false positives
					duplicateSimilarityThreshold: 0.95, // Require high similarity
					useFuzzyMatching: true // Use fuzzy matching for duplicate detection
				},
				overlapDetection: {
					minOverlapLength: 40, // Minimum 40 characters (handles larger transcription drift at boundaries)
					maxOverlapLength: 500, // Maximum 500 characters
					searchRangeInNext: 800, // Search early in next chunk (overlap should appear near the start)
					candidateStepSize: 10, // Finer scan to cover 40-150 char overlaps
					similarityThreshold: 0.78 // Allow small differences in transcription across chunks
				}
			},
			pricing: {
				costPerMinute: 0.003, // $0.003 per minute for GPT-4o Mini
				currency: 'USD'
			}
			// Note: GPT-4o Mini primarily uses contextWindowSize for continuity, but merging settings still apply for deduplication
		}
	},

	vad: {
		sensitivity: 0.7, // VAD sensitivity (0-1)
		minSpeechDuration: 0.3, // Minimum speech segment duration in seconds
		maxSilenceDuration: 0.5, // Maximum silence duration to bridge segments
		speechPadding: 0.2 // Padding around speech segments in seconds
	},

	audio: {
		targetSampleRate: AUDIO_CONSTANTS.SAMPLE_RATE, // 16kHz - optimal for speech recognition
		targetBitDepth: AUDIO_CONSTANTS.BIT_DEPTH, // 16-bit - sufficient for speech
		targetChannels: AUDIO_CONSTANTS.CHANNELS // Mono - reduces file size and processing time
	}
};

const logger = Logger.getLogger('ModelProcessingConfig');

/**
 * Model name to config key mapping
 */
export const MODEL_CONFIG_MAP: Record<string, keyof TranscriptionConfig['models']> = {
	'whisper-1': 'whisper',
	'whisper-1-ts': 'whisperTs',
	'gpt-4o-transcribe': 'gpt4o',
	'gpt-4o-mini-transcribe': 'gpt4oMini'
};

/**
 * Configuration cache to prevent duplicate fetches
 */
const configCache = new Map<string, ModelConfig & {
	vadChunking: ModelConfig['vadChunking'] & {
		minChunkDuration: number;
		maxChunkDuration: number;
	}
}>();

/**
 * Get model configuration by model name with calculated VAD chunk durations
 */
export function getModelConfig(modelName: string): ModelConfig & {
	vadChunking: ModelConfig['vadChunking'] & {
		minChunkDuration: number;
		maxChunkDuration: number;
	}
} {
	// Check cache first
	const cached = configCache.get(modelName);
	if (cached) {
		return cached;
	}


	const configKey = MODEL_CONFIG_MAP[modelName];
	if (!configKey) {
		const availableModels = Object.keys(MODEL_CONFIG_MAP).join(', ');
		throw new Error(`[Config] Unknown model: "${modelName}". Available models: ${availableModels}`);
	}

	const baseConfig = DEFAULT_TRANSCRIPTION_CONFIG.models[configKey];

	// Calculate min/max chunk durations from variance
	const minChunkDuration = baseConfig.chunkDurationSeconds - baseConfig.vadChunking.chunkDurationVariance;
	const maxChunkDuration = baseConfig.chunkDurationSeconds + baseConfig.vadChunking.chunkDurationVariance;

	// Calculate appropriate context window size based on overlap duration
	// This ensures the context covers the entire overlap period
	const calculatedContextWindowSize = baseConfig.contextWindowSize > 0
		? Math.max(
				baseConfig.contextWindowSize,
				Math.ceil(baseConfig.vadChunking.overlapDurationSeconds * (baseConfig.merging.estimatedCharsPerSecond ?? 15))
			)
			: baseConfig.contextWindowSize;

	// Create extended config with calculated values
	const config = {
		...baseConfig,
		contextWindowSize: calculatedContextWindowSize,
		vadChunking: {
			...baseConfig.vadChunking,
			minChunkDuration,
			maxChunkDuration
		}
	};


	// Cache the configuration
	configCache.set(modelName, config);

	return config;
}

/**
 * Get transcription configuration with optional overrides
 */
export function getTranscriptionConfig(overrides?: Partial<TranscriptionConfig>): TranscriptionConfig {
	if (!overrides) {
		return DEFAULT_TRANSCRIPTION_CONFIG;
	}

	// Deep merge overrides with defaults
	return {
		models: {
			whisper: { ...DEFAULT_TRANSCRIPTION_CONFIG.models.whisper, ...overrides.models?.whisper },
			whisperTs: { ...DEFAULT_TRANSCRIPTION_CONFIG.models.whisperTs, ...overrides.models?.whisperTs },
			gpt4o: { ...DEFAULT_TRANSCRIPTION_CONFIG.models.gpt4o, ...overrides.models?.gpt4o },
			gpt4oMini: { ...DEFAULT_TRANSCRIPTION_CONFIG.models.gpt4oMini, ...overrides.models?.gpt4oMini }
		},
		vad: { ...DEFAULT_TRANSCRIPTION_CONFIG.vad, ...overrides.vad },
		audio: { ...DEFAULT_TRANSCRIPTION_CONFIG.audio, ...overrides.audio }
	};
}

/**
 * Debug function to display all model configurations
 */
export function logAllModelConfigs(): void {
	logger.info('All model configurations:');
	Object.entries(MODEL_CONFIG_MAP).forEach(([modelName, configKey]) => {
		logger.info(`  ${modelName}: ${configKey}`);
	});
}

/**
 * Clear the configuration cache (for testing purposes)
 */
export function clearConfigCache(): void {
	configCache.clear();
}
