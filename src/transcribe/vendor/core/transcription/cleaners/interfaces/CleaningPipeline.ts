/**
 * Interface for text cleaning pipelines
 * Pipelines coordinate multiple cleaners in a specific order
 */

import type { TextCleaner, CleaningResult, CleaningContext } from './TextCleaner';

export interface PipelineResult {
	/** Final cleaned text after all cleaners */
	finalText: string;
	/** Results from each cleaner in order */
	stageResults: CleaningStageResult[];
	/** Overall metadata */
	metadata: {
		totalOriginalLength: number;
		totalFinalLength: number;
		totalReductionRatio: number;
		stagesExecuted: number;
		totalIssuesFound: number;
		processingTimeMs?: number;
	};
}

export interface CleaningStageResult {
	/** Name of the cleaner that produced this result */
	cleanerName: string;
	/** Result from this specific cleaner */
	result: CleaningResult;
	/** Processing time for this stage */
	processingTimeMs?: number;
}

/**
 * Configuration for a cleaning pipeline
 */
export interface PipelineConfig {
	/** Name of the pipeline */
	name: string;
	/** Cleaners to execute in order */
	cleaners: TextCleaner[];
	/** Model ID for safety threshold configuration */
	modelId?: string;
	/** Whether to stop pipeline on first serious issue */
	stopOnCriticalIssue?: boolean;
	/** Maximum allowed reduction ratio before stopping */
	maxReductionRatio?: number;
	/** Whether to log detailed results */
	enableDetailedLogging?: boolean;
}

/**
 * Interface for cleaning pipeline implementations
 */
export interface CleaningPipeline {
	/** Name of the pipeline */
	readonly name: string;

	/** Configuration for this pipeline */
	readonly config: PipelineConfig;

	/**
	 * Execute the full cleaning pipeline
	 * @param text - Original text to clean
	 * @param language - Language code
	 * @param context - Cleaning context
	 * @returns Complete pipeline result
	 */
	execute: (text: string, language: string, context?: CleaningContext) => Promise<PipelineResult>;

	/**
	 * Get list of cleaners in execution order
	 */
	getCleaners: () => TextCleaner[];

	/**
	 * Add a cleaner to the pipeline
	 */
	addCleaner: (cleaner: TextCleaner) => void;

	/**
	 * Remove a cleaner from the pipeline
	 */
	removeCleaner: (cleanerName: string) => boolean;
}