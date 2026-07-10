/**
 * Standard cleaning pipeline implementation
 * Executes multiple text cleaners in sequence with error handling and monitoring
 */

import { Logger } from '../../../utils/Logger';

import type {
	CleaningPipeline,
	PipelineResult,
	CleaningStageResult,
	PipelineConfig
} from './interfaces/CleaningPipeline';
import type { TextCleaner, CleaningContext } from './interfaces/TextCleaner';

	export class StandardCleaningPipeline implements CleaningPipeline {
		readonly name: string;
		readonly config: PipelineConfig;
		private logger = Logger.getLogger('StandardCleaningPipeline');

		constructor(config: PipelineConfig) {
			this.name = config.name;
			this.config = {
				stopOnCriticalIssue: false,
				maxReductionRatio: 0.8,
				enableDetailedLogging: false,
				...config
		};
	}

	/**
	 * Execute the full cleaning pipeline
	 */
	async execute(text: string, language: string, context?: CleaningContext): Promise<PipelineResult> {
		const startTime = Date.now();
		const stageResults: CleaningStageResult[] = [];
		const originalLength = text.length;
		let currentText = text;
		let totalIssuesFound = 0;

		// Add original text length to context for validators
		const enhancedContext: CleaningContext = {
			...context,
			customData: {
				...context?.customData,
				originalLength
			}
		};

		for (const cleaner of this.config.cleaners) {
			if (!cleaner.enabled) {
				continue;
			}

			const stageStartTime = Date.now();

			try {
				if (this.config.enableDetailedLogging) {
					this.logger.debug('Executing cleaner', { cleaner: cleaner.name });
				}

				// Execute the cleaner
				const result = await Promise.resolve(cleaner.clean(currentText, language, enhancedContext));
				const stageEndTime = Date.now();

				// Record stage result
				const stageResult: CleaningStageResult = {
					cleanerName: cleaner.name,
					result,
					processingTimeMs: stageEndTime - stageStartTime
				};
				stageResults.push(stageResult);

				// Trust each cleaner's internal safety mechanisms
				// Each cleaner is responsible for its own safety thresholds
				currentText = result.cleanedText;

				totalIssuesFound += result.issues.length;

				// Log issues if found
				if (result.issues.length > 0 && this.config.enableDetailedLogging) {
					this.logger.warn(`Cleaner ${cleaner.name} reported issues`, {
						issues: result.issues
					});
				}

				// Check for critical issues that should stop the pipeline
				if (this.config.stopOnCriticalIssue && this.isCriticalIssue(result.issues)) {
					this.logger.warn(`Critical issue detected in ${cleaner.name}, stopping pipeline`);
					break;
				}

				// Trust the combined judgment of all cleaners
				// Each cleaner has already applied its own safety thresholds

			} catch (error) {
				this.logger.error(`Error in ${cleaner.name}:`, error);

				// Record the error but continue with other cleaners
				const stageResult: CleaningStageResult = {
					cleanerName: cleaner.name,
					result: {
						cleanedText: currentText, // Keep previous text
						issues: [`Error in ${cleaner.name}: ${error instanceof Error ? error.message : 'Unknown error'}`],
						hasSignificantChanges: false,
						metadata: {
							originalLength: currentText.length,
							cleanedLength: currentText.length,
							reductionRatio: 0
						}
					},
					processingTimeMs: Date.now() - stageStartTime
				};
				stageResults.push(stageResult);
				totalIssuesFound += 1;
			}
		}

		const endTime = Date.now();
		const finalLength = currentText.length;
		const totalReductionRatio = (originalLength - finalLength) / originalLength;

		const pipelineResult: PipelineResult = {
			finalText: currentText,
			stageResults,
			metadata: {
				totalOriginalLength: originalLength,
				totalFinalLength: finalLength,
				totalReductionRatio,
				stagesExecuted: stageResults.length,
				totalIssuesFound,
				processingTimeMs: endTime - startTime
			}
		};


		if (this.config.enableDetailedLogging) {
			this.logger.info('Standard cleaning pipeline summary', pipelineResult.metadata);
		}

		return pipelineResult;
	}

	/**
	 * Get list of cleaners in execution order
	 */
	getCleaners(): TextCleaner[] {
		return [...this.config.cleaners];
	}

	/**
	 * Add a cleaner to the pipeline
	 */
	addCleaner(cleaner: TextCleaner): void {
		this.config.cleaners.push(cleaner);
	}

	/**
	 * Remove a cleaner from the pipeline
	 */
	removeCleaner(cleanerName: string): boolean {
		const index = this.config.cleaners.findIndex(cleaner => cleaner.name === cleanerName);
		if (index !== -1) {
			this.config.cleaners.splice(index, 1);
			return true;
		}
		return false;
	}

	/**
	 * Check if any issues are critical enough to stop the pipeline
	 */
	private isCriticalIssue(issues: string[]): boolean {
		const criticalPatterns = [
			/excessive text removal/i,
			/extreme text reduction/i,
			/encoding issues/i,
			/unicode replacement characters/i
		];

		return issues.some(issue =>
			criticalPatterns.some(pattern => pattern.test(issue))
		);
	}

	/**
	 * Get summary of pipeline execution
	 */
	getSummary(result: PipelineResult): string {
		const { metadata } = result;
		const reductionPercent = Math.round(metadata.totalReductionRatio * 100);
		const processingTimeMs = metadata.processingTimeMs ?? 0;

		return [
			`Pipeline: ${this.name}`,
			`Stages: ${metadata.stagesExecuted}`,
			`Text: ${metadata.totalOriginalLength} → ${metadata.totalFinalLength} chars (${reductionPercent}% reduction)`,
			`Issues: ${metadata.totalIssuesFound}`,
			`Time: ${processingTimeMs}ms`
		].join(' | ');
	}
}
