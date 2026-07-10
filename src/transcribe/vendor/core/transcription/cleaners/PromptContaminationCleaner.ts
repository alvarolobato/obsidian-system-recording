/**
 * Prompt contamination cleaner
 * Removes system prompts and context markers that leak into GPT-4o transcription output
 */

import {
	getModelCleaningStrategy
} from '../../../config/ModelCleaningConfig';
import { Logger } from '../../../utils/Logger';

import { PatternCompiler, GENERIC_XML_TAG } from './utils/PatternCompiler';

import type { TextCleaner, CleaningResult, CleaningContext } from './interfaces/TextCleaner';
import type {
	ModelCleaningStrategy,
	ContaminationPatterns
} from '../../../config/ModelCleaningConfig';


type XmlPatternGroupName = 'completeXmlTags' | 'sentenceBoundedTags' | 'lineBoundedTags' | 'standaloneTags';

export interface PromptContaminationConfig {
	/** Custom prompts to remove (in addition to default patterns) */
	customPrompts?: string[];
	/** Whether to remove XML-style context tags */
	removeXmlTags?: boolean;
	/** Whether to remove context patterns */
	removeContextPatterns?: boolean;
	/** Whether to use aggressive pattern matching */
	aggressiveMatching?: boolean;
	/** Model ID for safety threshold configuration */
	modelId?: string;
}

export class PromptContaminationCleaner implements TextCleaner {
	readonly name = 'PromptContaminationCleaner';
	readonly enabled = true;

	private config: PromptContaminationConfig;
	private contaminationPatterns: ContaminationPatterns;
	private strategy: ModelCleaningStrategy;
	private logger: Logger;

	/**
	 * Instruction patterns (will be loaded from configuration)
	 */
	private commonInstructionPatterns: string[] = [];

	/**
	 * XML pattern groups (will be loaded from configuration)
	 */
	private xmlPatternGroups: Record<XmlPatternGroupName, RegExp[]> = {
		completeXmlTags: [],
		sentenceBoundedTags: [],
		lineBoundedTags: [],
		standaloneTags: []
	};

	/**
	 * Context patterns (will be loaded from configuration)
	 */
	private contextPatterns: RegExp[] = [];

	constructor(config: PromptContaminationConfig = {}, strategy?: ModelCleaningStrategy) {
		this.config = {
			removeXmlTags: true,
			removeContextPatterns: true,
			aggressiveMatching: false,
			modelId: 'gpt-4o-mini-transcribe', // Default fallback
			...config
		};
		this.strategy = strategy ?? getModelCleaningStrategy(this.config.modelId || 'gpt-4o-mini-transcribe');
		this.logger = Logger.getLogger('PromptContaminationCleaner');

		// Load contamination patterns from strategy or use defaults
			this.contaminationPatterns = this.strategy.contaminationPatterns ?? {
				instructionPatterns: [],
				xmlPatternGroups: {
					completeXmlTags: [],
					sentenceBoundedTags: [],
				lineBoundedTags: [],
				standaloneTags: []
			},
			contextPatterns: [],
			promptSnippetLengths: [10, 15, 20, 30]
		};

		// Load and compile patterns
		if (this.strategy.contaminationPatterns) {
			this.loadPatternsFromStrategy(this.strategy.contaminationPatterns);
			this.logger.debug('Loaded contamination patterns', {
				instructionPatternCount: this.commonInstructionPatterns.length,
				xmlPatternGroupCount: Object.keys(this.xmlPatternGroups).length,
				contextPatternCount: this.contextPatterns.length
			});
		}
	}

	/**
	 * Load and compile patterns from strategy configuration
	 */
		private loadPatternsFromStrategy(patterns: ContaminationPatterns): void {
			// Load instruction patterns
			this.commonInstructionPatterns = patterns.instructionPatterns;

			// Compile XML patterns
			for (const [group, patternStrings] of Object.entries(patterns.xmlPatternGroups)) {
				if ((group) in this.xmlPatternGroups) {
					const key = group as XmlPatternGroupName;
					this.xmlPatternGroups[key] = PatternCompiler.compileMany(patternStrings);
				}
			}

			// Compile context patterns
			this.contextPatterns = PatternCompiler.compileMany(patterns.contextPatterns);
		}

	/**
	 * Clean text by removing prompt contamination
	 */
	clean(text: string, _language: string = 'auto', context?: CleaningContext): CleaningResult {
		const originalLength = text.length;
		const patternsMatched: string[] = [];
		const issues: string[] = [];
		let cleaned = text;

		// STEP 1: Remove XML-style tags with priority-based approach
		if (this.config.removeXmlTags) {
			cleaned = this.processXmlPatterns(cleaned, originalLength, patternsMatched, issues);
		}

		// STEP 2: Remove prompt instructions that appear at the beginning
		const allPrompts = [...this.commonInstructionPatterns];
		if (this.config.customPrompts) {
			allPrompts.push(...this.config.customPrompts);
		}

		// Add prompts from context if available
		if (context?.originalPrompt) {
			allPrompts.push(context.originalPrompt);
		}

		// Remove exact matches at the beginning
		for (const prompt of allPrompts) {
			if (cleaned.startsWith(prompt)) {
				cleaned = cleaned.substring(prompt.length).trim();
				patternsMatched.push('Beginning prompt');
				break; // Stop after first match to avoid checking against already cleaned text
			}
		}

		// STEP 3: Remove context patterns
		if (this.config.removeContextPatterns) {
			for (const pattern of this.contextPatterns) {
				const before = cleaned.length;
				cleaned = cleaned.replace(pattern, '');
				if (before !== cleaned.length) {
					patternsMatched.push('Context pattern');
				}
			}
		}

		// STEP 4: Advanced pattern matching for prompts anywhere in text
		if (this.config.aggressiveMatching) {
			for (const prompt of allPrompts) {
				const patterns = this.buildPromptPatterns(prompt);
				for (const pattern of patterns) {
					const before = cleaned.length;
					cleaned = cleaned.replace(pattern, (match) => match.startsWith('\n') ? '\n' : '');
					if (before !== cleaned.length) {
						patternsMatched.push('Embedded prompt');
					}
				}
			}
		}

		// STEP 5: Remove duplicate paragraphs (context sometimes gets repeated)
		cleaned = this.removeDuplicateParagraphs(cleaned);

		// STEP 6: Final cleanup
		cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
		cleaned = cleaned.trim();

		const cleanedLength = cleaned.length;
		const reductionRatio = originalLength > 0 ? (originalLength - cleanedLength) / originalLength : 0;

		// Apply safety thresholds from configuration (strategy injected from pipeline)
		const thresholds = this.strategy.safetyThresholds;

		// Detect potential issues with configured thresholds
		if (reductionRatio > thresholds.warningThreshold) {
			issues.push(`Text reduction warning: ${Math.round(reductionRatio * 100)}% removed (threshold: ${Math.round(thresholds.warningThreshold * 100)}%)`);
		}

		// Emergency fallback: preserve original text if reduction is too extreme
		if (reductionRatio > thresholds.emergencyFallbackThreshold) {
			issues.push(`Emergency fallback: preserving original text due to ${Math.round(reductionRatio * 100)}% reduction (threshold: ${Math.round(thresholds.emergencyFallbackThreshold * 100)}%)`);
			cleaned = text; // Restore original text
		}

		if (patternsMatched.length > thresholds.maxPatternsBeforeWarning) {
			issues.push(`High contamination pattern count: ${patternsMatched.length} (threshold: ${thresholds.maxPatternsBeforeWarning}) - possible prompt bleeding`);
		}

		// Check for remaining XML-like patterns
		const remainingXml = cleaned.match(/<[^>]+>/g);
		if (remainingXml && remainingXml.length > 0) {
			issues.push(`Remaining XML-like patterns detected: ${remainingXml.length} instances`);
		}

		return {
			cleanedText: cleaned,
			issues,
			hasSignificantChanges: reductionRatio > 0.05,
			metadata: {
				originalLength,
				cleanedLength,
				reductionRatio,
				patternsMatched
			}
		};
	}

	/**
	 * Build regex patterns for removing prompts, including truncated versions
	 */
	private buildPromptPatterns(prompt: string): RegExp[] {
		const escapedPrompt = this.escapeRegExp(prompt);
		const patterns = [
			// Exact matches at start of line or after newline
			new RegExp(`^${escapedPrompt}\\s*`, 'gm'),
			new RegExp(`\\n${escapedPrompt}\\s*`, 'g'),
			new RegExp(`^${escapedPrompt}$`, 'gm'),
			// Match prompt anywhere in text (in case it's embedded)
			new RegExp(`${escapedPrompt}\\s*`, 'g')
			];

			// Also check for partial prompts (use configured lengths)
			const lengths = this.contaminationPatterns.promptSnippetLengths;
			for (const len of lengths) {
				if (prompt.length >= len) {
					const snippet = prompt.slice(0, len);
				const escapedSnippet = this.escapeRegExp(snippet);
				// Only match if followed by the rest of a likely prompt pattern
				patterns.push(new RegExp(`${escapedSnippet}[^。.!?！？\\n]{0,50}(?:ください|してください|です|ます)`, 'g'));
			}
		}

		return patterns;
	}

	/**
	 * Remove duplicate paragraphs that may result from context repetition
	 */
	private removeDuplicateParagraphs(text: string): string {
		const paragraphs = text.split(/\n\n+/);
		const uniqueParagraphs = [];
		const seen = new Set();

		for (const para of paragraphs) {
			const normalized = para.trim();
			if (normalized && !seen.has(normalized)) {
				seen.add(normalized);
				uniqueParagraphs.push(normalized);
			}
		}

		return uniqueParagraphs.join('\n\n');
	}

	/**
	 * Escape text for use in regular expressions
	 */
	private escapeRegExp(text: string): string {
		return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/**
	 * Process XML patterns with priority-based approach to prevent conflicts
	 */
	private processXmlPatterns(
		text: string,
		originalLength: number,
		patternsMatched: string[],
		_issues: string[]
	): string {
		let cleaned = text;
		const maxReduction = this.strategy.safetyThresholds.singlePatternMaxReduction;

			// Process pattern groups in priority order
			const groups = [
				{ name: 'Complete XML tags', patterns: this.xmlPatternGroups.completeXmlTags },
				{ name: 'Sentence-bounded tags', patterns: this.xmlPatternGroups.sentenceBoundedTags },
				{ name: 'Line-bounded tags', patterns: this.xmlPatternGroups.lineBoundedTags },
				{ name: 'Standalone tags', patterns: this.xmlPatternGroups.standaloneTags }
			];

		for (const group of groups) {
			for (const pattern of group.patterns) {
				const before = cleaned.length;
				const afterReplace = cleaned.replace(pattern, '');

				// Check if this pattern causes excessive reduction
				const patternReduction = (before - afterReplace.length) / originalLength;
				if (patternReduction > maxReduction) {
					// Skip this pattern to preserve content
					patternsMatched.push(`${group.name} (skipped: ${Math.round(patternReduction * 100)}% > ${Math.round(maxReduction * 100)}%)`);
					continue;
				}

				// Apply the pattern if safe
				cleaned = afterReplace;
				if (before !== cleaned.length) {
					patternsMatched.push(`${group.name} (${Math.round(patternReduction * 100)}%)`);
				}
			}
		}

		// Finally, remove any generic XML tags that weren't caught by specific patterns
		// This catches custom tags like <短いタグ> without needing specific configuration
		const beforeGeneric = cleaned.length;
		cleaned = cleaned.replace(GENERIC_XML_TAG, '');
		if (beforeGeneric !== cleaned.length) {
			patternsMatched.push('Generic XML tags');
		}

		return cleaned;
	}

	/**
	 * Update configuration
	 */
	updateConfig(newConfig: Partial<PromptContaminationConfig>): void {
		this.config = { ...this.config, ...newConfig };
	}
}
