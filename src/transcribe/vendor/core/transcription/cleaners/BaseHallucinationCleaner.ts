/**
 * Base hallucination cleaner
 * Removes common hallucinations and repetitive patterns from transcribed text
 */

import { Logger } from '../../../utils/Logger';

import { PatternCompiler, META_BRACKET } from './utils/PatternCompiler';
import { sliceHeadGraphemes, splitIntoSentences } from './utils/TextSegmentation';
import { calculateInclusionSimilarity, normalizeForComparison } from './utils/TextSimilarity';

import type { DictionaryCorrector } from '../DictionaryCorrector';
import type { TextCleaner, CleaningResult, CleaningContext } from './interfaces/TextCleaner';
import type {
	ModelCleaningStrategy,
	HallucinationPatterns,
	RepetitionThresholds
} from '../../../config/ModelCleaningConfig';



	export class BaseHallucinationCleaner implements TextCleaner {
		readonly name = 'BaseHallucinationCleaner';
		readonly enabled = true;

		private dictionaryCorrector: DictionaryCorrector | null = null;
		private strategy: ModelCleaningStrategy | null = null;
		private logger: Logger;

	/**
	 * Hallucination patterns (will be loaded from configuration)
	 */
	private hallucinationPatterns: Record<keyof HallucinationPatterns, RegExp[]> = {
		japanese: [],
		english: [],
		chinese: [],
		korean: []
	};

	/**
	 * Repetition thresholds (will be loaded from configuration)
	 */
	private repetitionThresholds: RepetitionThresholds = {
		baseThreshold: 30,
		lengthFactor: 10,
		essentialParticles: ['は', 'が', 'を', 'に', 'の', 'で', 'と', 'から', 'まで', 'より', 'へ', 'も', 'や', 'か'],
		commonExpressions: ['その', 'この', 'あの', 'って', 'ので', 'けど', 'だけど', 'でも', 'まあ', 'ちょっと'],
		sentenceRepetition: 5,
		similarityThreshold: 0.85
	};

		constructor(dictionaryCorrector?: DictionaryCorrector, strategy?: ModelCleaningStrategy) {
			this.dictionaryCorrector = dictionaryCorrector ?? null;
			this.strategy = strategy ?? null;
			this.logger = Logger.getLogger('BaseHallucinationCleaner');
			if (this.dictionaryCorrector) {
				this.logger.debug('DictionaryCorrector attached for hallucination cleaning');
			}

		// Load patterns from strategy if provided
		if (strategy?.hallucinationPatterns) {
			this.hallucinationPatterns = this.compilePatterns(strategy.hallucinationPatterns);
			this.logger.debug('Loaded hallucination patterns', {
				languages: Object.keys(this.hallucinationPatterns),
				patternCounts: Object.entries(this.hallucinationPatterns).reduce((acc, [lang, patterns]) => {
					acc[lang] = patterns.length;
					return acc;
				}, {} as Record<string, number>)
			});
		}

		// Load thresholds from strategy if provided
		if (strategy?.repetitionThresholds) {
			this.repetitionThresholds = strategy.repetitionThresholds;
			this.logger.debug('Loaded repetition thresholds', {
				baseThreshold: this.repetitionThresholds.baseThreshold,
				lengthFactor: this.repetitionThresholds.lengthFactor
			});
		}
	}

	/**
	 * Compile string patterns into RegExp objects
	 */
	private compilePatterns(patterns: HallucinationPatterns): Record<keyof HallucinationPatterns, RegExp[]> {
		const compiled: Record<keyof HallucinationPatterns, RegExp[]> = {
			japanese: [],
			english: [],
			chinese: [],
			korean: []
		};

		// Compile each pattern string into RegExp using the common utility
		for (const language of Object.keys(patterns) as Array<keyof HallucinationPatterns>) {
			const patternStrings = patterns[language];
			if (Array.isArray(patternStrings)) {
				compiled[language] = PatternCompiler.compileMany(patternStrings);
			}
		}

		// Add dynamic patterns for each supported language
		compiled.japanese.push(...this.generatePromptContaminationPatterns('ja'));
		compiled.english.push(...this.generatePromptContaminationPatterns('en'));
		compiled.chinese.push(...this.generatePromptContaminationPatterns('zh'));
		compiled.korean.push(...this.generatePromptContaminationPatterns('ko'));

		return compiled;
	}

	/**
	 * Clean text by removing hallucinations
	 */
	clean(text: string, language: string = 'auto', context?: CleaningContext): Promise<CleaningResult> {
		const originalLength = text.length;
		const patternsMatched: string[] = [];
		const issues: string[] = [];
		const removedSections: Array<{type: string, content: string, reason: string}> = [];
		const enableDetailedLogging = context?.enableDetailedLogging ?? this.strategy?.enableDetailedLogging ?? false;

		this.logger.debug('Starting hallucination cleaning', {
			originalLength,
			language,
			enableDetailedLogging
		});

		if (enableDetailedLogging) {
			this.logger.trace('Initial input length', { length: text.length });
		}

		// Remove meta information brackets unconditionally (before safety threshold checks)
		const metaMatches = text.match(META_BRACKET);
		if (metaMatches && metaMatches.length > 0) {
			text = text.replace(META_BRACKET, '');
			patternsMatched.push('META_BRACKET');
			if (enableDetailedLogging) {
				removedSections.push({
					type: 'meta_bracket',
					content: `<redacted: ${metaMatches.join(', ').length} chars>`,
					reason: 'Audio/visual meta information artifacts'
				});
			}
		}


		// Determine language-specific patterns to apply
		let patterns: RegExp[];

		if (language === 'auto') {
			// For auto-detection, combine all patterns (prioritize Japanese)
			patterns = [
				...this.hallucinationPatterns.japanese,
				...this.hallucinationPatterns.english,
				...this.hallucinationPatterns.chinese,
				...this.hallucinationPatterns.korean
			];
		} else if (language === 'ja') {
			patterns = this.hallucinationPatterns.japanese;
		} else if (language === 'en') {
			patterns = this.hallucinationPatterns.english;
		} else if (language === 'zh') {
			patterns = this.hallucinationPatterns.chinese;
		} else if (language === 'ko') {
			patterns = this.hallucinationPatterns.korean;
		} else {
			// Default to Japanese patterns for other languages
			patterns = this.hallucinationPatterns.japanese;
		}


		let cleanedText = text;

		// Multi-stage cleaning process
			const maxIterations = this.strategy?.safetyThresholds.maxCleaningIterations ?? 3;
		let iteration = 0;
		let previousLength = cleanedText.length;

		while (iteration < maxIterations) {

			// Stage 1: Apply hallucination removal patterns with improved logic
			cleanedText = this.applyImprovedPatternRemoval(cleanedText, patterns, originalLength, patternsMatched, removedSections, enableDetailedLogging);

			// Stage 2: Apply medium-length phrase repetition removal
			// This catches patterns like "そういうのがあるというのが" repeated multiple times
			// Now also handles enumeration patterns through delegation
			cleanedText = this.removeMediumLengthRepetitions(cleanedText, enableDetailedLogging, removedSections);

			// Check if text length changed
			const currentLength = cleanedText.length;
			if (currentLength === previousLength) {
				// No more changes, exit loop
				break;
			}

			// Safety check: prevent excessive reduction in a single iteration
			// For mechanical repetitions (like medium-length phrases),
			// we allow up to configured limit (default 99.9%)
				const iterationReductionLimit = this.strategy?.safetyThresholds.iterationReductionLimit ?? 0.999;
			const iterationReduction = (previousLength - currentLength) / previousLength;
			if (iterationReduction > iterationReductionLimit) {
				if (enableDetailedLogging) {
					this.logger.warn('Iteration reduction exceeded threshold', {
						iteration,
						iterationReduction,
						limit: iterationReductionLimit
					});
				}
				break;
			}

			previousLength = currentLength;
			iteration++;
		}

		// Remove invalid Unicode characters
		cleanedText = cleanedText.replace(/\uFFFD+/g, '');
		cleanedText = cleanedText.replace(/[\uFFF0-\uFFFF]/g, '');

		// Clean up formatting while preserving Japanese text structure
			const newlineLimit = this.repetitionThresholds.consecutiveNewlineLimit ?? 3;
		const newlineRegex = new RegExp(`\\n{${newlineLimit},}`, 'g');

		if (language === 'ja' || language === 'auto') {
			// For Japanese, be more careful with whitespace
			cleanedText = cleanedText.replace(/[ \t]+/g, ' '); // Only collapse spaces/tabs
			cleanedText = cleanedText.replace(newlineRegex, '\n\n');
		} else {
			// Preserve paragraph structure across languages (avoid collapsing newlines into spaces)
			cleanedText = cleanedText.replace(/[ \t]+/g, ' ');
			cleanedText = cleanedText.replace(newlineRegex, '\n\n');
		}
		cleanedText = cleanedText.trim();

		// Dictionary corrections are now applied after cleaning pipeline

		// Remove paragraph-level repetitions if enabled
		if (this.repetitionThresholds.paragraphRepeat?.enabled !== false) {
			cleanedText = this.removeParagraphRepeats(cleanedText, language, enableDetailedLogging, removedSections);
		}

		// Collapse repeating sentences (use configured threshold)
		cleanedText = this.collapseRepeatingSentences(cleanedText, language, this.repetitionThresholds.sentenceRepetition);

		const cleanedLength = cleanedText.length;
		const reductionRatio = originalLength > 0 ? (originalLength - cleanedLength) / originalLength : 0;

		// Check for excessive reduction
			const excessiveReductionWarning = this.strategy?.safetyThresholds.excessiveReductionWarning ?? 0.5;
		if (reductionRatio > excessiveReductionWarning) {
			issues.push(`Excessive text reduction: ${Math.round(reductionRatio * 100)}% removed`);
		}

		// Check for patterns that might indicate remaining issues
			const highPatternCountWarning = this.strategy?.safetyThresholds.highPatternCountWarning ?? 10;
		if (patternsMatched.length > highPatternCountWarning) {
			issues.push(`High number of hallucination patterns detected: ${patternsMatched.length}`);
		}

		// Detailed logging if enabled
		if (enableDetailedLogging) {
			if (removedSections.length > 0) {
				removedSections.forEach((removal, index) => {
					this.logger.debug(`Removed section #${index + 1}`, removal);
				});
			} else {
				this.logger.debug('No sections removed during hallucination cleaning');
			}
		}

			const significantChangeThreshold = this.strategy?.safetyThresholds.significantChangeThreshold ?? 0.1;

		return Promise.resolve({
			cleanedText,
			issues,
			hasSignificantChanges: reductionRatio > significantChangeThreshold,
			metadata: {
				originalLength,
				cleanedLength,
				reductionRatio,
				patternsMatched,
				...(enableDetailedLogging && { removedSections })
			}
		});
	}

	/**
	 * Apply improved pattern removal with context awareness and dynamic thresholds
	 */
	private applyImprovedPatternRemoval(
		text: string,
		patterns: RegExp[],
		originalLength: number,
		patternsMatched: string[],
		removedSections: Array<{type: string, content: string, reason: string}> = [],
		enableDetailedLogging: boolean = false
	): string {
		let cleanedText = text;

		for (const pattern of patterns) {
			if (enableDetailedLogging) {
				this.logger.trace('Evaluating hallucination pattern', { pattern: pattern.toString() });
			}

			const beforeText = cleanedText;
			const beforeLength = cleanedText.length;

			// Special handling for the problematic short character repetition pattern
			if (pattern.toString().includes('[あ-んア-ン]{1,4}')) {
				cleanedText = this.applyContextAwareShortCharRemoval(cleanedText, originalLength);

				if (beforeLength !== cleanedText.length && enableDetailedLogging) {
					// Find what was removed
					const removed = this.findRemovedText(beforeText, cleanedText);
					removedSections.push({
						type: 'short_char_repetition',
						content: `<redacted: ${removed.length} chars>`,
						reason: 'Excessive short character repetition detected'
					});
				}
			} else {
				// Determine if this is a repetition pattern or phrase pattern
				const isRepetitionPattern = this.isRepetitionPattern(pattern);

				// Get appropriate maximum reduction threshold
				const maxReduction = isRepetitionPattern
					? (this.strategy?.safetyThresholds.repetitionPatternMaxReduction ?? 1.0)
					: (this.strategy?.safetyThresholds.phrasePatternMaxReduction ??
					   this.strategy?.safetyThresholds.singlePatternMaxReduction ?? 0.2);

				// Test the pattern replacement
				const matches = cleanedText.match(pattern);
				const afterReplace = cleanedText.replace(pattern, '');
				const patternReduction = (beforeLength - afterReplace.length) / originalLength;

				if (enableDetailedLogging && matches) {
					this.logger.trace('Pattern match count', {
						pattern: pattern.toString(),
						matchCount: matches.length
					});
				}

				// Apply pattern only if within safe reduction limit
				if (patternReduction <= maxReduction) {
					if (enableDetailedLogging) {
						this.logger.debug('Pattern applied', {
							pattern: pattern.toString(),
							reduction: patternReduction
						});
					}
					cleanedText = afterReplace;

					if (beforeLength !== cleanedText.length && enableDetailedLogging) {
						const matches = Array.from(beforeText.matchAll(pattern));
						for (const match of matches) {
							removedSections.push({
								type: isRepetitionPattern ? 'repetition_pattern' : 'phrase_pattern',
								content: `<redacted: ${match[0].length} chars>`,
								reason: `Pattern matched: ${pattern.toString().substring(0, 50)}...`
							});
						}
					}
				} else if (enableDetailedLogging) {
					this.logger.debug('Skipped pattern due to reduction limit', {
						pattern: pattern.toString(),
						reduction: patternReduction,
						maxReduction
					});
				}
			}

			if (beforeLength !== cleanedText.length) {
				patternsMatched.push(pattern.toString());
			}
		}

		return cleanedText;
	}

	/**
	 * Determine if a pattern is a repetition pattern (e.g., {10,}, {20,}) or phrase pattern
	 */
	private isRepetitionPattern(pattern: RegExp): boolean {
		const patternStr = pattern.toString();
		// Check for repetition quantifiers like {8,}, {10,}, {20,}, etc.
		return /\{\d+,\}/.test(patternStr);
	}

	/**
	 * Context-aware removal of repeated short characters with dynamic thresholds
	 */
	private applyContextAwareShortCharRemoval(text: string, originalLength: number): string {
		// Calculate dynamic threshold based on text length
		const baseThreshold = this.repetitionThresholds.baseThreshold;
		const dynamicThresholdDivisor = this.repetitionThresholds.dynamicThresholdDivisor ?? 100;
		const lengthFactor = Math.floor(originalLength / dynamicThresholdDivisor); // Add 1 per divisor chars
		const dynamicThreshold = baseThreshold + (lengthFactor * this.repetitionThresholds.lengthFactor);

		// Essential Japanese particles that should NEVER be mass-deleted
		const essentialParticles = this.repetitionThresholds.essentialParticles;

		// Common conjunctions and expressions that are often repeated naturally
		const commonExpressions = this.repetitionThresholds.commonExpressions;

		// Get configuration for short char detection
		const minLength = this.repetitionThresholds.shortCharMinLength ?? 1;
		const maxLength = this.repetitionThresholds.shortCharMaxLength ?? 4;
		const maxConsecutiveParticles = this.repetitionThresholds.maxConsecutiveParticles ?? 5;
		const particleMode = this.repetitionThresholds.particleReductionMode ?? 'limit';

		// Find repetitive patterns but exclude essential elements
		const words = text.split(/\s+/);
		const wordCount = new Map<string, number>();

		// Count occurrences of each short character word
		for (const word of words) {
				const cleanWord = word.replace(/[。、！？\s]/g, '');
				if (cleanWord.length >= minLength && cleanWord.length <= maxLength && /^[あ-んア-ン]+$/.test(cleanWord)) {
					wordCount.set(cleanWord, (wordCount.get(cleanWord) ?? 0) + 1);
				}
			}

		let result = text;

		// Remove only truly excessive repetitions, preserving essential particles
		for (const [word, count] of wordCount.entries()) {
			let keepCount = 0;
			let shouldReduce = false;

			if (essentialParticles.includes(word)) {
				// Handle particles based on mode
				switch (particleMode) {
				case 'preserve':
					// Never reduce particles
					continue;
				case 'limit':
					// Limit to maxConsecutiveParticles
					if (count > maxConsecutiveParticles) {
						keepCount = maxConsecutiveParticles;
						shouldReduce = true;
					}
					break;
				case 'reduce':
					// Apply normal reduction but with higher threshold
					if (count >= dynamicThreshold * 2) {
						keepCount = Math.max(maxConsecutiveParticles, Math.floor(count * 0.3));
						shouldReduce = true;
					}
					break;
				}
				} else if (commonExpressions.includes(word)) {
					// Common expressions need higher threshold
					if (count >= dynamicThreshold * 1.5) {
						const keepRatio = this.repetitionThresholds.shortCharKeepRatio ?? 0.2;
						keepCount = Math.max(2, Math.floor(count * keepRatio));
						shouldReduce = true;
					}
				} else if (count >= dynamicThreshold) {
					// Normal short words
					const keepRatio = this.repetitionThresholds.shortCharKeepRatio ?? 0.2;
					keepCount = Math.max(1, Math.floor(count * keepRatio));
					shouldReduce = true;
				}

			if (shouldReduce) {
					// Create regex to match the word with optional punctuation
					const wordRegex = new RegExp(`${word}[。、]?\\s*`, 'g');
					const matches = result.match(wordRegex) ?? [];
					const removeCount = count - keepCount;

				if (matches.length >= removeCount) {
					// Remove excessive occurrences from the end
					for (let i = 0; i < removeCount; i++) {
						result = result.replace(wordRegex, '');
					}
				}
			}
		}

		return result;
	}

	/**
	 * Collapse consecutive repeating sentences with similarity detection
	 */
	private collapseRepeatingSentences(text: string, language: string, threshold: number = 5): string {
		// Split while preserving whitespace/newlines after sentence endings.
		const sentences = splitIntoSentences(text, language);
		const result: string[] = [];
		let previous = '';
		let count = 0;

		for (const sentence of sentences) {
			const currentSentence = sentence.trim();
			const previousSentence = previous.trim();

			// Check for exact match or high similarity (for hallucination detection)
			if (currentSentence.length > 0 &&
				(currentSentence === previousSentence || this.isSimilarSentence(currentSentence, previousSentence))) {
				count++;
			} else {
				if (previous !== '') {
					if (count >= threshold) {
						// Keep only one instance if repeated threshold+ times
						result.push(previous);
					} else {
						// Keep all instances if below threshold
						for (let i = 0; i < count; i++) {
							result.push(previous);
						}
					}
				}
				previous = sentence;
				count = 1;
			}
		}

		// Handle the last group
		if (previous !== '') {
			if (count >= threshold) {
				result.push(previous);
			} else {
				for (let i = 0; i < count; i++) {
					result.push(previous);
				}
			}
		}

		let collapsedText = result.join('');

		// Remove extreme trailing repetitions
			const trailingRepCount = this.repetitionThresholds.extremeTrailingRepetitionCount ?? 10;
		const trailingRegex = new RegExp(`(\\s*[・。、]\\s*){${trailingRepCount},}$`, 'g');
		collapsedText = collapsedText.replace(trailingRegex, '。');

		return collapsedText.trim();
	}

	/**
	 * Check if two sentences are similar enough to be considered repetitive hallucination
	 * Uses character-level similarity with Japanese-aware processing
	 */
	private isSimilarSentence(sent1: string, sent2: string): boolean {
		// Skip similarity check for very short sentences (likely natural)
			const minLength = this.repetitionThresholds.minimumSentenceLengthForSimilarity ?? 6;
		if (sent1.length < minLength || sent2.length < minLength) {
			return false;
		}

		const norm1 = normalizeForComparison(sent1);
		const norm2 = normalizeForComparison(sent2);

		const similarity = calculateInclusionSimilarity(norm1, norm2);

		// Consider similar if threshold% or more characters match (configurable threshold)
		return similarity >= this.repetitionThresholds.similarityThreshold;
	}

	/**
	 * Remove medium-length phrase repetitions
	 * Targets patterns like "そういうのがあるというのが" repeated multiple times
	 */
	private removeMediumLengthRepetitions(
		text: string,
		enableDetailedLogging: boolean = false,
		removedSections: Array<{type: string, content: string, reason: string}> = []
	): string {
		let cleanedText = text;


		// Get configuration from strategy, with fallback to default
			const lengthRanges = this.repetitionThresholds.mediumLengthRanges ?? [
				{ min: 5, max: 10, threshold: 3 },    // Default: Short phrases repeated 3+ times
				{ min: 10, max: 20, threshold: 2 },   // Default: Medium phrases repeated 2+ times
				{ min: 20, max: 30, threshold: 2 }    // Default: Longer phrases repeated 2+ times
			];

		for (const range of lengthRanges) {
			const pattern = new RegExp(`(.{${range.min},${range.max}}?)\\1{${range.threshold - 1},}`, 'g');

			cleanedText = cleanedText.replace(pattern, (match: string, repeatedUnit: string) => {
				// Check if this match segment is an enumeration pattern
				if (this.repetitionThresholds.enumerationDetection?.enabled &&
				    this.isEnumerationSegment(match)) {
					// Delegate to enumeration-specific compression
					const compressed = this.collapseRepeatingEnumerations(match);

					if (enableDetailedLogging && match !== compressed) {
						removedSections.push({
							type: 'enumeration_repetition',
							content: `<redacted: ${match.length} chars>`,
							reason: `Enumeration compressed (${match.length}→${compressed.length} chars)`
						});
					}
					return compressed;
				}

				// Normal phrase compression
				if (enableDetailedLogging) {
					removedSections.push({
						type: 'medium_length_repetition',
						content: `<redacted: ${match.length} chars>`,
						reason: `Phrase "${repeatedUnit}" repeated`
					});
				}
				return repeatedUnit; // Keep only one instance
			});
		}

		// Additional pass for exact duplicates with flexible spacing
		// This catches patterns with slight variations in whitespace
		// Use the min/max from configuration to stay consistent
		const minLength = Math.min(...lengthRanges.map(r => r.min));
		const maxLength = Math.max(...lengthRanges.map(r => r.max));
		const flexiblePattern = new RegExp(`(.{${minLength},${maxLength}})\\s*\\1+`, 'g');
		cleanedText = cleanedText.replace(flexiblePattern, '$1');

		return cleanedText;
	}

	/**
	 * Generate prompt contamination patterns from configuration
	 */
	private generatePromptContaminationPatterns(language: string): RegExp[] {
		const patterns: RegExp[] = [];

		// Get prompt patterns from strategy configuration
		if (this.strategy?.contaminationPatterns?.instructionPatterns) {
			const prompts = this.strategy.contaminationPatterns.instructionPatterns;

			// Language-specific sentence endings
				const sentenceEndings = {
					ja: '[。、]',
					en: '[.,!?]',
					zh: '[。，！？]',
					ko: '[.!?]'
				} as const;

					// Get appropriate sentence ending pattern for the language
					const endingPattern = Object.prototype.hasOwnProperty.call(sentenceEndings, language)
						? sentenceEndings[language as keyof typeof sentenceEndings]
						: sentenceEndings.en; // Default to English

			// Convert prompt phrases to regex patterns for any language
			for (const prompt of prompts) {
				// Escape special regex characters and create exact match pattern
				const escapedPrompt = prompt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				patterns.push(new RegExp(`^${escapedPrompt}${endingPattern}?\\s*$`, 'g'));
			}
		}

		return patterns;
	}

	/**
	 * Remove paragraph-level repetitions using fingerprint approach
	 * Detects repeated sentences based on their beginning characters
	 */
	private removeParagraphRepeats(
		text: string,
		language: string,
		enableDetailedLogging: boolean = false,
		removedSections: Array<{type: string, content: string, reason: string}> = []
		): string {
			const config = this.repetitionThresholds.paragraphRepeat;
			if (!config || config.enabled === false) {
				return text;
			}

			const sentences = splitIntoSentences(text, language);
			const headChars = config.headChars;
			const minRepeatCount = config.minRepeatCount ?? 3;
			const similarityThreshold = config.similarityThreshold ?? 0.9;
			const minLength = this.repetitionThresholds.minimumSentenceLengthForSimilarity ?? 6;

			const getFingerprint = (normalized: string): string => sliceHeadGraphemes(normalized, headChars);

			const keep: string[] = [];
			let run: { items: string[]; fp: string; lastNormalized: string } | null = null;

			const flushRun = (): void => {
				if (!run) {
					return;
				}

				const runLength = run.items.length;
				if (runLength >= minRepeatCount) {
					keep.push(run.items[0] ?? '');
					if (enableDetailedLogging && runLength > 1) {
						for (let i = 1; i < runLength; i++) {
							const removed = run.items[i] ?? '';
							removedSections.push({
								type: 'paragraph_repeat',
								content: `<redacted: ${removed.length} chars>`,
								reason: `Consecutive sentence repeat compressed (run=${runLength}, min=${minRepeatCount})`
							});
						}
					}
				} else {
					keep.push(...run.items);
				}

				run = null;
			};

			// Single pass: compress consecutive repeats with fingerprint + similarity guard
			for (let i = 0; i < sentences.length; i++) {
				const sentence = sentences[i] ?? '';
				if (!sentence.trim()) {
					continue;
				}

				const normalized = normalizeForComparison(sentence);
				const fp = getFingerprint(normalized);

				if (!run) {
					run = { items: [sentence], fp, lastNormalized: normalized };
					continue;
				}

				const fingerprintMatches = fp === run.fp;
				const isComparable = normalized.length >= minLength && run.lastNormalized.length >= minLength;
				const isSimilar = fingerprintMatches && isComparable
					? calculateInclusionSimilarity(run.lastNormalized, normalized) >= similarityThreshold
					: false;

				if (isSimilar) {
					run.items.push(sentence);
					run.lastNormalized = normalized;
					continue;
				}

				flushRun();
				run = { items: [sentence], fp, lastNormalized: normalized };
			}

			flushRun();

			return keep.join('');
	}

	/**
	 * Helper method to find what text was removed between before and after
	 */
	private findRemovedText(before: string, after: string): string {
		// Simple diff approach - find common prefix and suffix
		let commonPrefix = 0;
		let commonSuffix = 0;

		const minLength = Math.min(before.length, after.length);

		// Find common prefix
		while (commonPrefix < minLength && before[commonPrefix] === after[commonPrefix]) {
			commonPrefix++;
		}

		// Find common suffix
		while (commonSuffix < minLength - commonPrefix &&
			   before[before.length - 1 - commonSuffix] === after[after.length - 1 - commonSuffix]) {
			commonSuffix++;
		}

		// Extract the removed part
		const removedStart = commonPrefix;
		const removedEnd = before.length - commonSuffix;

		if (removedEnd > removedStart) {
			return before.substring(removedStart, removedEnd);
		}

		return ''; // No clear removal detected
	}

	/**
	 * Collapse repeating enumeration patterns within sentences
	 * Example: "A、B、C、A、B、C、A、B、C" → "A、B、C"
	 *
	 * This handles AI hallucinations where lists (e.g., country names) are repeated multiple times
	 * within a single sentence. Designed to be language-agnostic and work with both Japanese and Western commas.
	 */
	private collapseRepeatingEnumerations(text: string): string {
		// Check if feature is enabled
			const enumerationConfig = this.repetitionThresholds.enumerationDetection;
			if (!enumerationConfig?.enabled) {
				return text;
			}

			const minRepeatCount = enumerationConfig.minRepeatCount ?? 3;
			const sentences = text.split(/(?<=[。.!?！？])\s*/);

		return sentences.map(sentence => {
			// Detect separator - find the actual separator character used
			const commaMatch = sentence.match(/[、,]/);
			if (!commaMatch) {
				return sentence;
			}

			const separator = commaMatch[0]; // Use the actual separator found
			const elements = sentence.split(new RegExp(`\\s*${separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`));

			// Skip if too few elements to form meaningful patterns
			if (elements.length < minRepeatCount * 2) {
				return sentence;
			}

			// Extract punctuation from last element
				const lastElement = elements[elements.length - 1] ?? '';
				const punctuation = lastElement.match(/[。.!?！？]+$/)?.[0] || '';
				if (punctuation) {
					elements[elements.length - 1] = lastElement.slice(0, -punctuation.length).trim();
			}

				// Debug log (do not log raw text)
				if (this.strategy?.enableDetailedLogging) {
					this.logger.debug('[EnumerationDebug] Analyzing sentence', {
						sentenceLength: sentence.length,
						elementCount: elements.length
					});
				}

			// Try to find repeating patterns
			// Skip patternLength = 1 (single word repetition) and start from 2
			for (let patternLength = 2; patternLength <= Math.floor(elements.length / minRepeatCount); patternLength++) {
				// Early termination check - calculate max possible repeats
				const maxPossibleRepeats = Math.floor((elements.length - patternLength) / patternLength) + 1;
				if (maxPossibleRepeats < minRepeatCount) {
					break;
				}

				if (this.isRepeatingPattern(elements, patternLength, minRepeatCount)) {
					const compressed = elements.slice(0, patternLength);

					// Reconstruct with original separator and punctuation
					const result = compressed.join(separator === '、' ? '、' : ', ') + punctuation;

					if (this.strategy?.enableDetailedLogging) {
						this.logger.debug(`[EnumerationDebug] Pattern found! patternLength=${patternLength}`);
						this.logger.debug(`[EnumerationDebug] Compressed: ${elements.length} → ${compressed.length}`);
					}

					// Log if we actually compressed something
					if (this.strategy?.enableDetailedLogging && elements.length > compressed.length) {
						this.logger.debug(`Compressed enumeration: ${elements.length} → ${compressed.length} elements`);
					}

					return result;
				}
			}

			return sentence;
		}).join(' ').trim();
	}

	/**
	 * Check if elements form a repeating pattern
	 */
	private isRepeatingPattern(elements: string[], patternLength: number, minRepeatCount: number): boolean {
		const pattern = elements.slice(0, patternLength);
		let consecutiveRepeats = 1;

		for (let i = patternLength; i < elements.length; i += patternLength) {
			// Check if we have enough elements left for a full pattern
			if (i + patternLength > elements.length) {
				// Allow partial match at the end only if we already have enough full repeats
				return consecutiveRepeats >= minRepeatCount;
			}

			const candidate = elements.slice(i, i + patternLength);
			if (this.arePatternsSimilar(pattern, candidate)) {
				consecutiveRepeats++;
			} else {
				// Pattern broken - check if we had enough repeats
				break;
			}
		}

		return consecutiveRepeats >= minRepeatCount;
	}

	/**
	 * Compare two patterns with normalization
	 * Uses NFKC normalization to handle full-width/half-width differences
	 */
		private arePatternsSimilar(pattern1: string[], pattern2: string[]): boolean {
			if (pattern1.length !== pattern2.length) {
				return false;
			}

			for (let i = 0; i < pattern1.length; i++) {
				// Normalize: trim whitespace and apply NFKC normalization
				const norm1 = (pattern1[i] ?? '').trim().normalize('NFKC');
				const norm2 = (pattern2[i] ?? '').trim().normalize('NFKC');

				// Exact match after normalization
				if (norm1 !== norm2) {
					return false;
				}
			}

			return true;
		}

	/**
	 * Check if a text segment contains repeating enumeration pattern
	 * This is more thorough than looksLikeEnumeration - it verifies actual periodicity
	 */
	private isEnumerationSegment(segment: string): boolean {
		// Detect separator type
		const sep = segment.includes('、') ? '、' : (segment.includes(',') ? ',' : '');
		if (!sep) {
			return false;
		}

		// Split by separator and filter empty parts
		const parts = segment.split(new RegExp(`\\s*${sep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`))
		                    .filter(p => p.trim().length > 0);

		// Need at least 4 parts to have meaningful repetition
		if (parts.length < 4) {
			return false;
		}

		// Try to find repeating pattern of length 2 to n/2
		for (let patternLen = 2; patternLen <= Math.floor(parts.length / 2); patternLen++) {
			// Check if we can have enough repetitions with this pattern length
			const repetitions = Math.floor(parts.length / patternLen);
			const minRep = this.repetitionThresholds.enumerationDetection?.minRepeatCount ?? 3;

			if (repetitions < minRep) {
				continue;
			}

			// Extract the pattern
			const pattern = parts.slice(0, patternLen);
			let isRepeating = true;

			// Check if the pattern repeats throughout
			for (let i = 0; i < repetitions; i++) {
				for (let j = 0; j < patternLen; j++) {
					const idx = i * patternLen + j;
					if (idx >= parts.length || parts[idx] !== pattern[j]) {
						isRepeating = false;
						break;
					}
				}
				if (!isRepeating) {
					break;
				}
			}

			if (isRepeating) {
				return true;
			}
		}

		return false;
	}
}
