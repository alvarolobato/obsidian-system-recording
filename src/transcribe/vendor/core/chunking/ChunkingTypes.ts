/**
 * Core chunking types
 * Defines the data structures for audio chunking strategies
 */

import type { ProcessedAudio } from '../audio/AudioTypes';

/**
 * Chunking strategy configuration
 */
export interface ChunkStrategy {
	/** Whether chunking is needed */
	needsChunking: boolean;
	/** Total number of chunks that will be created */
	totalChunks: number;
	/** Alias for totalChunks for backward compatibility */
	chunkCount?: number;
	/** Duration of each chunk in seconds */
	chunkDuration: number;
	/** Overlap duration between chunks in seconds */
	overlapDuration: number;
	/** Total audio duration in seconds */
	totalDuration: number;
	/** Reason for chunking (size, duration, both) */
	reason?: 'file_size' | 'duration' | 'both';
	/** Type of chunking strategy */
	type?: string;
	/** Estimated total processing time */
	estimatedProcessingTime?: number;
}

/**
 * Model-specific chunking constraints
 */
export interface ChunkingConstraints {
	/** Maximum file size in MB */
	maxSizeMB: number;
	/** Maximum total duration in seconds (API provider limit) */
	maxDurationSeconds: number;
	/** Preferred chunk duration in seconds (for chunking decisions) */
	chunkDurationSeconds: number;
	/** Recommended overlap in seconds */
	recommendedOverlapSeconds: number;
	/** Overlap duration in seconds (alias for recommendedOverlapSeconds) */
	overlapDurationSeconds?: number;
	/** Whether parallel processing is supported */
	supportsParallelProcessing: boolean;
	/** Maximum concurrent chunks for parallel processing */
	maxConcurrentChunks?: number;
}

/**
 * Chunk processing mode
 */
export type ChunkProcessingMode = 'sequential' | 'parallel' | 'batch';

/**
 * Chunk merge strategy
 */
export interface ChunkMergeStrategy {
	/** Type of merge strategy */
	type: 'simple' | 'overlap_removal' | 'context_aware';
	/** Configuration for the merge strategy */
	config?: {
		/** For overlap removal: minimum match length */
		minMatchLength?: number;
		/** For context aware: context extraction function */
		contextExtractor?: (text: string) => string;
		/** For simple: separator between chunks */
		separator?: string;
	};
}

/**
 * Chunking service configuration
 */
export interface ChunkingConfig {
	/** Model-specific constraints */
	constraints: ChunkingConstraints;
	/** Processing mode */
	processingMode: ChunkProcessingMode;
	/** Use server-side VAD to determine chunk boundaries */
	useServerVAD?: boolean;
	/** Merge strategy */
	mergeStrategy: ChunkMergeStrategy;
	/** Whether to optimize chunk boundaries at natural breaks */
	optimizeBoundaries?: boolean;
	/** Custom boundary detection (e.g., silence, sentence ends) */
	boundaryDetector?: (audio: ProcessedAudio) => number[] | Promise<number[]>;
	/** Model name for model-specific configurations */
	modelName?: string;
}
