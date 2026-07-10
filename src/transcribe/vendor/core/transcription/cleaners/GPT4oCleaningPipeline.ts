/**
 * GPT-4o specific cleaning pipeline
 * Handles GPT-4o's unique issues including prompt contamination and XML-style context tags
 */

import { getModelCleaningStrategy } from '../../../config/ModelCleaningConfig';

import { BaseHallucinationCleaner } from './BaseHallucinationCleaner';
import { ConsecutiveBlockRepeatCleaner } from './ConsecutiveBlockRepeatCleaner';
import { JapaneseTextValidator } from './JapaneseTextValidator';
import { PromptContaminationCleaner } from './PromptContaminationCleaner';
import { StandardCleaningPipeline } from './StandardCleaningPipeline';
import { TailRepeatCleaner } from './TailRepeatCleaner';

import type { JapaneseValidationConfig } from './JapaneseTextValidator';
import type { DictionaryCorrector } from '../DictionaryCorrector';
import type { PipelineConfig } from './interfaces/CleaningPipeline';


export interface GPT4oPipelineOptions {
	/** Model ID for configuration lookup */
	modelId?: string;
	/** Whether to use aggressive prompt contamination removal */
	aggressivePromptCleaning?: boolean;
	/** Custom prompts to remove */
	customPrompts?: string[];
	/** Whether to enable detailed logging */
	enableDetailedLogging?: boolean;
	/** Whether to validate Japanese text quality */
	enableJapaneseValidation?: boolean;
}

/**
 * @deprecated Use `TranscriptionService.cleanText()` (pipeline factory) instead.
 */
export class GPT4oCleaningPipeline extends StandardCleaningPipeline {

	constructor(dictionaryCorrector?: DictionaryCorrector, options: GPT4oPipelineOptions = {}) {
		const {
			modelId = 'gpt-4o-mini-transcribe', // Default fallback
			aggressivePromptCleaning = false,
			customPrompts = [],
			enableDetailedLogging = false,
			enableJapaneseValidation = true
		} = options;

		// Get cleaning strategy from configuration
		const strategy = getModelCleaningStrategy(modelId);

		// Configure pipeline for GPT-4o using strategy settings
		const config: PipelineConfig = {
			name: 'GPT4oCleaningPipeline',
			cleaners: [
				// 1. Remove prompt contamination (most critical for GPT-4o)
				new PromptContaminationCleaner({
					customPrompts,
					removeXmlTags: strategy.promptContamination?.removeXmlTags ?? true,
					removeContextPatterns: strategy.promptContamination?.removeContextPatterns ?? true,
					aggressiveMatching: strategy.promptContamination?.aggressiveMatching ?? aggressivePromptCleaning,
					modelId
				}, strategy),

				// 2. Remove general hallucinations
				new BaseHallucinationCleaner(dictionaryCorrector, strategy),

				// 3. Compress repeated tail blocks (endless loops)
				new TailRepeatCleaner(strategy.tailRepeat),

				// 4. Compress consecutive duplicated blocks (mid-text loops)
				...(strategy.consecutiveBlockRepeat?.enabled !== false ? [
					new ConsecutiveBlockRepeatCleaner(strategy.consecutiveBlockRepeat)
				] : []),

				// 5. Validate Japanese text quality (if enabled)
				...(enableJapaneseValidation && strategy.japaneseValidation ? [
					(() => {
						const validationConfig: JapaneseValidationConfig = {};
						const jv = strategy.japaneseValidation;
						if (jv.maxReductionRatio !== undefined) {
							validationConfig.maxReductionRatio = jv.maxReductionRatio;
						}
						if (jv.expectedCharsPerSecond !== undefined) {
							validationConfig.expectedCharsPerSecond = jv.expectedCharsPerSecond;
						}
						if (jv.maxIncompleteWords !== undefined) {
							validationConfig.maxIncompleteWords = jv.maxIncompleteWords;
						}
						if (jv.maxMergedWords !== undefined) {
							validationConfig.maxMergedWords = jv.maxMergedWords;
						}
						if (jv.enableAdvancedChecks !== undefined) {
							validationConfig.enableAdvancedChecks = jv.enableAdvancedChecks;
						}

						return new JapaneseTextValidator(validationConfig, strategy);
					})()
				] : [])
			],
			stopOnCriticalIssue: strategy.stopOnCriticalIssue,
			maxReductionRatio: strategy.maxReductionRatio, // Use strategy configuration instead of hardcoded 0.7
			enableDetailedLogging: strategy.enableDetailedLogging || enableDetailedLogging
		};

		super(config);
	}

	/**
	 * Quick analysis of GPT-4o specific issues before processing
	 */
	analyzeGPT4oIssues(text: string): {
		hasXmlTags: boolean;
		hasPromptContamination: boolean;
		hasContextMarkers: boolean;
		estimatedContaminationLevel: 'low' | 'medium' | 'high';
		recommendations: string[];
	} {
		const issues = {
			hasXmlTags: /<[^>]+>/.test(text),
			hasPromptContamination: /(?:文字起こし|してください|出力に含めない)/.test(text),
			hasContextMarkers: /(?:前回終了箇所|前の文脈|Context:)/.test(text),
			estimatedContaminationLevel: 'low' as 'low' | 'medium' | 'high',
			recommendations: [] as string[]
		};

		// Estimate contamination level
		let contaminationScore = 0;
		if (issues.hasXmlTags) {
			contaminationScore += 2;
		}
		if (issues.hasPromptContamination) {
			contaminationScore += 1;
		}
		if (issues.hasContextMarkers) {
			contaminationScore += 2;
		}

		// Check for heavy prompt contamination
		const promptPatterns = text.match(/(?:音声内容|文字起こし|してください)/g);
		if (promptPatterns && promptPatterns.length > 3) {
			contaminationScore += 2;
		}

		if (contaminationScore >= 4) {
			issues.estimatedContaminationLevel = 'high';
			issues.recommendations.push('Use aggressive cleaning mode');
		} else if (contaminationScore >= 2) {
			issues.estimatedContaminationLevel = 'medium';
			issues.recommendations.push('Use standard cleaning with monitoring');
		} else {
			issues.estimatedContaminationLevel = 'low';
			issues.recommendations.push('Standard cleaning should be sufficient');
		}

		// Specific recommendations
		if (issues.hasXmlTags) {
			issues.recommendations.push('XML tag removal is critical');
		}
		if (issues.hasPromptContamination) {
			issues.recommendations.push('Prompt contamination cleaning needed');
		}
		if (text.length > 0 && text.trim().length / text.length < 0.8) {
			issues.recommendations.push('Excessive whitespace detected');
		}

		return issues;
	}

	/**
	 * Get GPT-4o specific pipeline summary
	 */
	getGPT4oSummary(text: string): string {
		const analysis = this.analyzeGPT4oIssues(text);

		return [
			'GPT-4o Pipeline Ready',
			`Contamination: ${analysis.estimatedContaminationLevel}`,
			`XML tags: ${analysis.hasXmlTags ? 'Yes' : 'No'}`,
			`Prompt contamination: ${analysis.hasPromptContamination ? 'Yes' : 'No'}`,
			`Text: ${text.length} chars`
		].join(' | ');
	}
}
