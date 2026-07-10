/**
 * Japanese text quality validator
 * Validates Japanese transcription quality and detects potential issues
 * Does not modify text, only reports quality issues
 */

import type { TextCleaner, CleaningResult, CleaningContext } from './interfaces/TextCleaner';
import type {
	ModelCleaningStrategy,
	ValidationPatterns,
	ValidationThresholds
} from '../../../config/ModelCleaningConfig';


export interface JapaneseValidationConfig {
	/** Maximum allowed reduction ratio before flagging as excessive */
	maxReductionRatio?: number;
	/** Minimum text length threshold */
	minTextLength?: number;
	/** Maximum incomplete word instances before flagging */
	maxIncompleteWords?: number;
	/** Maximum merged word instances before flagging */
	maxMergedWords?: number;
	/** Expected characters per second for Japanese speech */
	expectedCharsPerSecond?: number;
	/** Whether to perform advanced linguistic checks */
	enableAdvancedChecks?: boolean;
	/**
	 * When `language="auto"`, only run the Japanese validator if the text looks Japanese.
	 * This reduces false positives and prevents unintended pipeline fallback for English/mixed transcripts.
	 */
	autoDetectMinKanaRatio?: number;
	/** Minimum number of kana characters required when `language="auto"` */
	autoDetectMinKanaCount?: number;
}

export class JapaneseTextValidator implements TextCleaner {
	readonly name = 'JapaneseTextValidator';
	readonly enabled = true;

	private config: Required<JapaneseValidationConfig>;
	private validationPatterns: ValidationPatterns;
	private validationThresholds: ValidationThresholds;

	constructor(config: JapaneseValidationConfig = {}, strategy?: ModelCleaningStrategy) {
		this.config = {
			maxReductionRatio: 0.5,
			minTextLength: 60,
			maxIncompleteWords: 3,
			maxMergedWords: 5,
			expectedCharsPerSecond: 1.5,
			enableAdvancedChecks: true,
			autoDetectMinKanaRatio: 0.05,
			autoDetectMinKanaCount: 5,
			...config
			};

			// Load validation patterns from strategy or use defaults
			this.validationPatterns = strategy?.validationPatterns ?? {
				incompleteWord: '[はがにをでと](?:\\s|$)',
				mergedWord: '[あ-んア-ン]{1,2}[あ-んア-ン]{5,}',
				charRepetition: '(.)\\1{10,}',
			sentenceEnding: '[。！？]',
			strangePatterns: [
				'[あ-ん]{20,}',     // Too many hiragana in sequence
				'[ア-ン]{15,}',     // Too many katakana in sequence
				'[a-zA-Z]{10,}',    // Too much continuous Latin text
				'\\d{6,}'           // Very long numbers
			]
			};

			// Load validation thresholds from strategy or use defaults
			this.validationThresholds = strategy?.validationThresholds ?? {
				katakanaRatio: 0.3,
				particlelessSentenceLength: 20,
				hiraganaRatio: 0.8,
			kanjiRatio: 0.05,
			latinRatio: 0.2
		};
	}

	/**
	 * Validate Japanese text quality (does not modify text)
	 */
	clean(text: string, language: string = 'auto', context?: CleaningContext): CleaningResult {
		const issues: string[] = [];
		const originalLengthValue = context?.customData
			? (context.customData)['originalLength']
			: undefined;
		const originalLength = typeof originalLengthValue === 'number' ? originalLengthValue : text.length;

		// Only validate Japanese text (language='auto' is gated by script heuristics)
		if (!this.shouldValidateJapanese(text, language)) {
			return {
				cleanedText: text,
				issues: [],
				hasSignificantChanges: false,
				metadata: {
					originalLength: text.length,
					cleanedLength: text.length,
					reductionRatio: 0
				}
			};
		}

			// 1. Check reduction ratio (if original length is provided)
			if (typeof originalLength === 'number' && originalLength > 0 && originalLength !== text.length) {
				const reductionRatio = (originalLength - text.length) / originalLength;
				if (reductionRatio > this.config.maxReductionRatio) {
					issues.push(`Excessive text removal: ${Math.round(reductionRatio * 100)}% of original text removed`);
				}
			}

		// 2. Check for incomplete Japanese words (particles without content)
		const incompleteWordPattern = new RegExp(this.validationPatterns.incompleteWord, 'g');
		const incompleteMatches = text.match(incompleteWordPattern);
		if (incompleteMatches && incompleteMatches.length > this.config.maxIncompleteWords) {
			issues.push(`Possible incomplete words detected: ${incompleteMatches.length} instances (particles without content)`);
		}

		// 3. Check for merged words (long sequences of hiragana/katakana)
		const mergedWordPattern = new RegExp(this.validationPatterns.mergedWord, 'g');
		const mergedMatches = text.match(mergedWordPattern);
		if (mergedMatches && mergedMatches.length > this.config.maxMergedWords) {
			issues.push(`Possible merged words detected: ${mergedMatches.length} instances`);
		}

		// 4. Check if text is suspiciously short
		if (text.length < this.config.minTextLength) {
			issues.push(`Text too short: only ${text.length} characters`);
		}

		// 5. Check against expected length based on audio duration
		if (typeof context?.audioDuration === 'number' && typeof this.config.expectedCharsPerSecond === 'number') {
			const expectedLength = context.audioDuration * this.config.expectedCharsPerSecond;
			const actualLength = text.replace(/\s+/g, '').length;
			if (actualLength < expectedLength * 0.3) { // Less than 30% of expected
				issues.push(`Text significantly shorter than expected: ${actualLength} chars vs ~${Math.round(expectedLength)} expected`);
			}
		}

		// 6. Check for excessive repetition of single characters
		const charRepetitionPattern = new RegExp(this.validationPatterns.charRepetition, 'g');
		const repetitionMatches = text.match(charRepetitionPattern);
		if (repetitionMatches && repetitionMatches.length > 0) {
			issues.push(`Character repetition detected: ${repetitionMatches.length} instances`);
		}

		// 7. Check for proper sentence structure
		const sentenceEndingPattern = new RegExp(this.validationPatterns.sentenceEnding, 'g');
		const sentenceEndings = text.match(sentenceEndingPattern);
		const approximateWordCount = text.replace(/\s+/g, '').length;
		if (approximateWordCount > 100 && (!sentenceEndings || sentenceEndings.length < 2)) {
			issues.push('Missing proper sentence endings for Japanese text');
		}

		// 8. Advanced linguistic checks
		if (this.config.enableAdvancedChecks) {
			issues.push(...this.performAdvancedChecks(text));
		}

		// 9. Check for signs of encoding issues
		const encodingIssues = this.checkEncodingIssues(text);
		if (encodingIssues.length > 0) {
			issues.push(...encodingIssues);
		}

		// 10. Check for unnatural character distributions
		const distributionIssues = this.checkCharacterDistribution(text);
		if (distributionIssues.length > 0) {
			issues.push(...distributionIssues);
		}

		return {
			cleanedText: text, // Validator doesn't modify text
			issues,
			hasSignificantChanges: false, // Validator never changes text
			metadata: {
				originalLength: typeof originalLength === 'number' ? originalLength : text.length,
					cleanedLength: text.length,
					reductionRatio: typeof originalLength === 'number' && originalLength !== text.length && originalLength > 0
						? (originalLength - text.length) / originalLength
						: 0,
					patternsMatched: issues.map(issue => issue.split(':')[0] ?? issue)
				}
			};
		}

	private shouldValidateJapanese(text: string, language: string): boolean {
		if (language === 'ja') {
			return true;
		}

		if (language !== 'auto') {
			return false;
		}

		const compact = text.replace(/\s+/g, '');
		if (!compact) {
			return false;
		}

		const kanaCount = (compact.match(/[ぁ-ゖァ-ヺ]/g) ?? []).length;
		const kanaRatio = kanaCount / compact.length;

		return kanaCount >= this.config.autoDetectMinKanaCount &&
		       kanaRatio >= this.config.autoDetectMinKanaRatio;
	}

	/**
	 * Perform advanced linguistic checks for Japanese text
	 */
	private performAdvancedChecks(text: string): string[] {
			const issues: string[] = [];

			// Check for unbalanced parentheses/brackets
			const openParens = (text.match(/[（「『【〈]/g) ?? []).length;
			const closeParens = (text.match(/[）」』】〉]/g) ?? []).length;
			if (Math.abs(openParens - closeParens) > 2) {
				issues.push('Unbalanced parentheses or brackets detected');
			}

			// Check for excessive katakana (might indicate foreign word recognition issues)
			const katakanaRatio = (text.match(/[ア-ン]/g) ?? []).length / text.length;
			if (katakanaRatio > this.validationThresholds.katakanaRatio) {
				issues.push(`High katakana ratio: ${Math.round(katakanaRatio * 100)}% (possible foreign word recognition issues)`);
			}

		// Check for missing particles in longer sentences
		const sentences = text.split(/[。！？]/);
		let particlelessSentences = 0;
		for (const sentence of sentences) {
			if (sentence.length > this.validationThresholds.particlelessSentenceLength && !/[はがにをでと]/.test(sentence)) {
				particlelessSentences++;
			}
		}
		if (particlelessSentences > 2) {
			issues.push(`${particlelessSentences} long sentences without particles detected`);
		}

		// Check for unusual character combinations
		const strangePatterns = this.validationPatterns.strangePatterns.map(p => new RegExp(p));

		for (const pattern of strangePatterns) {
			if (pattern.test(text)) {
				issues.push(`Unusual character sequence detected: ${pattern.toString()}`);
			}
		}

		return issues;
	}

	/**
	 * Check for encoding-related issues
	 */
	private checkEncodingIssues(text: string): string[] {
		const issues: string[] = [];

		// Check for replacement characters
		if (text.includes('\uFFFD')) {
			issues.push('Unicode replacement characters detected (encoding issues)');
		}

		// Check for mixed writing systems in unusual ways
		const mixedPatterns = [
			/[あ-ん][A-Z][あ-ん]/, // hiragana-uppercase-hiragana
			/[ア-ン][a-z]{5,}[ア-ン]/ // katakana-lowercase-katakana
		];

		for (const pattern of mixedPatterns) {
			if (pattern.test(text)) {
				issues.push('Unusual mixed writing system patterns detected');
				break;
			}
		}

		return issues;
	}

	/**
	 * Check character distribution for anomalies
	 */
	private checkCharacterDistribution(text: string): string[] {
		const issues: string[] = [];
		const totalChars = text.length;

		if (totalChars === 0) {
			return issues;
			}

			// Count different character types
			const hiragana = (text.match(/[あ-ん]/g) ?? []).length;
			const kanji = (text.match(/[一-龯]/g) ?? []).length;
			const latin = (text.match(/[a-zA-Z]/g) ?? []).length;

		// Check for extremely unbalanced distributions
		const hiraganaRatio = hiragana / totalChars;
		const kanjiRatio = kanji / totalChars;
		const latinRatio = latin / totalChars;

		if (hiraganaRatio > this.validationThresholds.hiraganaRatio) {
			issues.push(`Extremely high hiragana ratio: ${Math.round(hiraganaRatio * 100)}% (possible transcription accuracy issues)`);
		}

		if (kanjiRatio < this.validationThresholds.kanjiRatio && totalChars > 100) {
			issues.push(`Very low kanji ratio: ${Math.round(kanjiRatio * 100)}% (unusual for Japanese text)`);
		}

		if (latinRatio > this.validationThresholds.latinRatio) {
			issues.push(`High Latin character ratio: ${Math.round(latinRatio * 100)}% (possible language detection issues)`);
		}

		return issues;
	}

	/**
	 * Update configuration
	 */
	updateConfig(newConfig: Partial<JapaneseValidationConfig>): void {
		this.config = { ...this.config, ...newConfig };
	}
}
