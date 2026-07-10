/**
 * Interface for text cleaning strategies
 * Each cleaner focuses on a specific type of text cleaning/validation
 */

export interface CleaningResult {
	/** The cleaned text */
	cleanedText: string;
	/** Issues found during cleaning */
	issues: string[];
	/** Whether significant changes were made */
	hasSignificantChanges: boolean;
	/** Metadata about the cleaning process */
	metadata?: {
		originalLength: number;
		cleanedLength: number;
		reductionRatio: number;
		patternsMatched?: string[];
	};
}

/**
 * Base interface for all text cleaners
 */
export interface TextCleaner {
	/** Name of the cleaner for logging/debugging */
	readonly name: string;

	/** Whether this cleaner is enabled */
	readonly enabled: boolean;

	/**
	 * Clean the provided text
	 * @param text - Original text to clean
	 * @param language - Language code (e.g., 'ja', 'en', 'auto')
	 * @param context - Optional context for cleaning decisions
	 * @returns Cleaning result with cleaned text and metadata
	 */
	clean: (text: string, language: string, context?: CleaningContext) => Promise<CleaningResult> | CleaningResult;
}

/**
 * Context information that can be passed to cleaners
 */
export interface CleaningContext {
	/** Model that generated the text (e.g., 'whisper-1', 'gpt-4o-mini-transcribe') */
	modelId?: string;
	/** Duration of the audio that was transcribed */
	audioDuration?: number;
	/** Whether this is a continuation chunk */
	isContinuation?: boolean;
	/** Previous context text for continuation chunks */
	previousContext?: string;
	/** Original prompt used for transcription */
	originalPrompt?: string;
	/** Enable detailed logging for debugging */
	enableDetailedLogging?: boolean;
	/** Custom data that specific cleaners might need */
	customData?: Record<string, unknown>;
}
