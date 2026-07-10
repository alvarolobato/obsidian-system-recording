/**
 * Abstract transcription service interface
 * Defines the contract that all AI transcription services must implement
 */

import { SUPPORTED_FORMATS } from '../../config/constants';
import { getModelCleaningStrategy } from '../../config/ModelCleaningConfig';
import { Logger } from '../../utils/Logger';

import {
	BaseHallucinationCleaner,
	ConsecutiveBlockRepeatCleaner,
	JapaneseTextValidator,
	PromptContaminationCleaner,
	TailRepeatCleaner,
	TimestampsTailRepeatCleaner,
	StandardCleaningPipeline
} from './cleaners';

import type {
	CleaningPipeline,
	CleaningContext,
	PipelineConfig,
	PipelineResult,
	TextCleaner
} from './cleaners';
import type { DictionaryCorrector } from './DictionaryCorrector';
import type {
	TranscriptionResult,
	TranscriptionOptions,
	ModelSpecificOptions,
	TranscriptionRequest,
	TranscriptionValidation
} from './TranscriptionTypes';
import type { ModelCleaningStrategy } from '../../config/ModelCleaningConfig';
import type { AudioChunk } from '../audio/AudioTypes';

export abstract class TranscriptionService {
	/**
	 * Model identifier (whisper-1, gpt-4o-transcribe, gpt-4o-mini-transcribe)
	 */
	abstract readonly modelId: string;

	/**
	 * Model display name
	 */
	abstract readonly modelName: string;

	/**
	 * Model capabilities
	 */
	abstract readonly capabilities: {
		supportsTimestamps: boolean;
		supportsWordLevel: boolean;
		supportsLanguageDetection: boolean;
		supportedLanguages: string[];
		maxFileSizeMB: number;
		maxDurationSeconds: number;
	};

	/**
	 * Validate transcription request
	 */
	abstract validate(request: TranscriptionRequest): Promise<TranscriptionValidation>;

	/**
	 * Transcribe a single audio chunk
	 */
	abstract transcribe(
		chunk: AudioChunk,
		options: TranscriptionOptions,
		modelOptions?: ModelSpecificOptions
	): Promise<TranscriptionResult>;

	/**
	 * Test API connection
	 */
	abstract testConnection(apiKey: string): Promise<boolean>;

	/**
	 * Estimate transcription cost
	 */
	abstract estimateCost(durationSeconds: number): {
		amount: number;
		currency: string;
		perMinute: number;
	};

	/**
	 * Get optimal chunk duration for this model
	 */
	abstract getOptimalChunkDuration(): number;

	/**
	 * Dictionary corrector instance for text correction
	 */
	protected dictionaryCorrector: DictionaryCorrector | undefined;

	/**
	 * Text cleaning pipeline for this model
	 */
	protected cleaningPipeline: CleaningPipeline | undefined;
	private cleaningDebugMode = false;

	/**
	 * Logger instance
	 */
	protected logger = Logger.getLogger('TranscriptionService');

	/**
	 * Check if language is supported
	 */
	isLanguageSupported(language: string): boolean {
		return language === 'auto' ||
		       this.capabilities.supportedLanguages.includes(language);
	}

	/**
	 * Get MIME type for file extension
	 */
	protected getMimeType(extension: string): string {
		const mimeTypes = SUPPORTED_FORMATS.MIME_TYPES;
		const key = extension.toLowerCase();
		const mimeType = (mimeTypes as Record<string, string | undefined>)[key];
		return mimeType ?? 'audio/mpeg';
	}

	/**
	 * Initialize the cleaning pipeline for this model
	 */
	protected initializeCleaningPipeline(debugMode: boolean = false): void {
		this.cleaningDebugMode = debugMode;
		const strategy = getModelCleaningStrategy(this.modelId, debugMode);

		// CLEANER_DEBUG_START - Remove this block after confirming new cleaner system works
		//
		//
		// CLEANER_DEBUG_END

		this.cleaningPipeline = this.buildPipelineForStrategy(strategy, { enableDetailedLogging: debugMode });

		// CLEANER_DEBUG_START - Remove this block after confirming new cleaner system works
		//
		// CLEANER_DEBUG_END
	}

	/**
	 * Clean text using the configured pipeline
	 */
	async cleanText(text: string, language: string = 'auto', context?: CleaningContext): Promise<string> {
		// Validate input
		if (!text || typeof text !== 'string') {
			this.logger.warn(`[${this.modelId}] Invalid text input for cleaning, returning empty string`);
			return '';
		}

		// Initialize pipeline if needed
		if (!this.cleaningPipeline) {
			try {
				this.initializeCleaningPipeline();
			} catch (initError) {
				this.logger.error(`[${this.modelId}] Failed to initialize cleaning pipeline`, initError);
				return text; // Return original text if initialization fails
			}
		}

		// Final check for pipeline availability
		if (!this.cleaningPipeline) {
			this.logger.warn(`[${this.modelId}] No cleaning pipeline available after initialization, returning original text`);
			return text;
		}

		try {
			const pipelineContext: CleaningContext = {
				modelId: this.modelId,
				...(context ?? {}),
				enableDetailedLogging: (context?.enableDetailedLogging ?? false) || this.cleaningDebugMode
			};
			const strategy = getModelCleaningStrategy(this.modelId, this.cleaningDebugMode);
			const result = await this.cleaningPipeline.execute(text, language, pipelineContext);
			let selectedResult = result;
			let selectedLabel: 'primary' | 'fallback1' | 'fallback2' = 'primary';

			// Pipeline-level fallback: avoid catastrophic deletion while keeping strong deduplication.
			// This re-runs the pipeline with safer settings when the output is suspiciously short.
			if (this.shouldRunPipelineFallback(result, pipelineContext, strategy)) {
				this.logger.warn(`[${this.modelId}] Cleaning pipeline fallback triggered`, {
					totalReductionRatio: result.metadata.totalReductionRatio,
					totalFinalLength: result.metadata.totalFinalLength
				});

				// Fallback level 1: keep hallucination cleaning, but disable paragraph fingerprint dedup.
				const safeStrategy1 = this.createStrategyWithAggressiveDedupDisabled(strategy);
				const safePipeline1 = this.buildPipelineForStrategy(safeStrategy1, {
					enableDetailedLogging: this.cleaningDebugMode
				});
				const safe1 = await safePipeline1.execute(text, language, pipelineContext);

				if (this.shouldRunPipelineFallback(safe1, pipelineContext, safeStrategy1)) {
					// Fallback level 2: preserve more content (omit hallucination cleaner), keep tail repeat + validator.
					const safePipeline2 = this.buildPipelineForStrategy(safeStrategy1, {
						omitHallucinationCleaner: true,
						enableDetailedLogging: this.cleaningDebugMode
					});
					const safe2 = await safePipeline2.execute(text, language, pipelineContext);
					selectedResult = safe2;
					selectedLabel = 'fallback2';
				} else {
					selectedResult = safe1;
					selectedLabel = 'fallback1';
				}
			}

			if (pipelineContext.enableDetailedLogging) {
				this.logger.debug(
					`[${this.modelId}] Cleaning pipeline audit (${selectedLabel})`,
					this.buildCleaningAudit(selectedResult)
				);
			}

			// Log summary if there were significant changes or issues
			if (selectedResult.metadata.totalIssuesFound > 0 || selectedResult.metadata.totalReductionRatio > 0.1) {
				this.logger.debug(`[${this.modelId}] Cleaning pipeline made significant adjustments`, {
					issuesFound: selectedResult.metadata.totalIssuesFound,
					reductionRatio: selectedResult.metadata.totalReductionRatio
				});
			}

			return selectedResult.finalText;
		} catch (error) {
			// Provide more detailed error information
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			const errorStack = error instanceof Error ? error.stack : undefined;

			this.logger.error(`[${this.modelId}] Text cleaning pipeline failed`, {
				error: errorMessage,
				textLength: text.length,
				language,
				context,
				stack: errorStack
			});

			// Return original text as fallback
			return text;
		}
	}

	private buildCleaningAudit(result: PipelineResult): {
		total: PipelineResult['metadata'];
		stageSequence: string;
		stages: Array<{
			cleanerName: string;
			originalLength: number;
			cleanedLength: number;
			reductionRatio: number;
			issuesFound: number;
			patternsMatchedCount: number;
			patternsMatchedSample: string[];
			processingTimeMs: number;
		}>;
	} {
		const stages = result.stageResults.map(stage => {
			const metadata = stage.result.metadata;
			const patternsMatched = metadata?.patternsMatched ?? [];
			return {
				cleanerName: stage.cleanerName,
				originalLength: metadata?.originalLength ?? stage.result.cleanedText.length,
				cleanedLength: metadata?.cleanedLength ?? stage.result.cleanedText.length,
				reductionRatio: metadata?.reductionRatio ?? 0,
				issuesFound: stage.result.issues.length,
				patternsMatchedCount: patternsMatched.length,
				patternsMatchedSample: patternsMatched.slice(0, 10),
				processingTimeMs: stage.processingTimeMs ?? 0
			};
		});

		return {
			total: result.metadata,
			stageSequence: stages.map(stage => stage.cleanerName).join(' -> '),
			stages
		};
	}

	private shouldRunPipelineFallback(
		result: PipelineResult,
		context: CleaningContext,
		strategy: ModelCleaningStrategy
	): boolean {
		const fallback = strategy.pipelineFallback;
		if (!fallback?.enabled) {
			return false;
		}

		const finalLength = result.metadata.totalFinalLength;
		if (finalLength <= 0) {
			// If we deleted everything, try a safer pass.
			return true;
		}

		// Collect issues across stages.
		const issues = result.stageResults.flatMap(stage => stage.result.issues);
		const hasCriticalIssue = issues.some(issue =>
			/emergency fallback/i.test(issue) ||
			/excessive text removal/i.test(issue) ||
			/text significantly shorter than expected/i.test(issue) ||
			/unicode replacement characters/i.test(issue) ||
			/encoding issues/i.test(issue)
		);

		const audioDuration = typeof context.audioDuration === 'number' ? context.audioDuration : null;
		const hasDuration = audioDuration !== null && audioDuration >= fallback.minAudioDurationSeconds;

		const actualChars = result.finalText.replace(/\s+/g, '').length;
		const expectedCharsPerSecond = strategy.japaneseValidation?.expectedCharsPerSecond ?? 1.5;
		const expectedChars = hasDuration ? audioDuration * expectedCharsPerSecond : null;
		const expectedRatio = expectedChars && expectedChars > 0 ? actualChars / expectedChars : null;

		const suspiciouslyShortByRatio = expectedRatio !== null && expectedRatio < fallback.minExpectedContentRatio;
		const suspiciouslyShortByLength = finalLength < fallback.minFinalTextLength;

		if (hasDuration && suspiciouslyShortByRatio && suspiciouslyShortByLength) {
			return true;
		}

		// Without reliable duration info, only fallback on both issues + extreme shortness.
		if (!hasDuration && hasCriticalIssue && suspiciouslyShortByLength && result.metadata.totalReductionRatio > 0.9) {
			return true;
		}

		return false;
	}

	private createStrategyWithAggressiveDedupDisabled(strategy: ModelCleaningStrategy): ModelCleaningStrategy {
		const repetitionThresholds = strategy.repetitionThresholds;

		const paragraphRepeat = repetitionThresholds?.paragraphRepeat
			? { ...repetitionThresholds.paragraphRepeat, enabled: false }
			: repetitionThresholds
				? { headChars: 15, enabled: false }
				: undefined;

		return {
			...strategy,
			...(repetitionThresholds && paragraphRepeat
				? {
					repetitionThresholds: {
						...repetitionThresholds,
						paragraphRepeat
					}
				}
				: {})
		};
	}

	private buildPipelineForStrategy(
		strategy: ModelCleaningStrategy,
		options?: { omitHallucinationCleaner?: boolean; enableDetailedLogging?: boolean }
	): CleaningPipeline {
		const cleaners: TextCleaner[] = [];
		const omitHallucinationCleaner = options?.omitHallucinationCleaner ?? false;
		const enableDetailedLogging = strategy.enableDetailedLogging || (options?.enableDetailedLogging ?? false);

		switch (strategy.pipelineType) {
			case 'gpt4o': {
				cleaners.push(new PromptContaminationCleaner({
					removeXmlTags: strategy.promptContamination?.removeXmlTags ?? true,
					removeContextPatterns: strategy.promptContamination?.removeContextPatterns ?? true,
					aggressiveMatching: strategy.promptContamination?.aggressiveMatching ?? false,
					modelId: strategy.modelId
				}, strategy));

				if (!omitHallucinationCleaner) {
					cleaners.push(new BaseHallucinationCleaner(this.dictionaryCorrector, strategy));
				}

				cleaners.push(new TailRepeatCleaner(strategy.tailRepeat));

				if (strategy.consecutiveBlockRepeat?.enabled !== false) {
					cleaners.push(new ConsecutiveBlockRepeatCleaner(strategy.consecutiveBlockRepeat));
				}

				if (strategy.japaneseValidation) {
					cleaners.push(new JapaneseTextValidator(strategy.japaneseValidation, strategy));
				}
				break;
			}

			case 'whisper': {
				if (!omitHallucinationCleaner) {
					cleaners.push(new BaseHallucinationCleaner(this.dictionaryCorrector, strategy));
				}

				cleaners.push(new TimestampsTailRepeatCleaner({
					enabled: strategy.tailRepeat?.enabled ?? true,
					minRepeatCount: strategy.tailRepeat?.minRepeatCount ?? 3,
					similarityThreshold: strategy.tailRepeat?.similarityThreshold ?? 0.9
				}));

				cleaners.push(new TailRepeatCleaner(strategy.tailRepeat));

				if (strategy.japaneseValidation) {
					cleaners.push(new JapaneseTextValidator(strategy.japaneseValidation, strategy));
				}
				break;
			}

			case 'standard':
				// No-op
				break;
		}

		const config: PipelineConfig = {
			name: `Pipeline(${strategy.modelId})`,
			modelId: strategy.modelId,
			cleaners,
			stopOnCriticalIssue: strategy.stopOnCriticalIssue,
			maxReductionRatio: strategy.maxReductionRatio,
			enableDetailedLogging
		};

		return new StandardCleaningPipeline(config);
	}

	/**
	 * Set debug mode for cleaning pipeline
	 * This will enable detailed logging of the cleaning process
	 */
	protected setCleaningDebugMode(debugMode: boolean): void {
		this.initializeCleaningPipeline(debugMode);
	}

	/**
	 * Enable detailed logging for troubleshooting cleaning issues
	 * This method should be used during development or when investigating
	 * text cleaning problems
	 */
	enableCleaningDebugMode(): void {
		this.setCleaningDebugMode(true);
	}

	/**
	 * Disable detailed logging to reduce console noise in production
	 */
	disableCleaningDebugMode(): void {
		this.setCleaningDebugMode(false);
	}

}
