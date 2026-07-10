/**
 * Tail repeat cleaner
 * Compresses "endless" hallucination loops that repeat at the end of the transcript.
 *
 * Design goals:
 * - Strong deduplication for tail loops (high confidence hallucination pattern)
 * - Avoid touching content in the middle of the transcript (reduce false positives)
 * - Tolerate minor punctuation/whitespace drift via normalization + similarity threshold
 */
import { Logger } from '../../../utils/Logger';

import { splitIntoSentences } from './utils/TextSegmentation';
import { areSimilarNormalizedText, normalizeForComparison } from './utils/TextSimilarity';

import type { TextCleaner, CleaningResult, CleaningContext } from './interfaces/TextCleaner';

export interface TailRepeatConfig {
	/** Enable tail repeat compression */
	enabled: boolean;
	/** Number of tail paragraphs to inspect */
	maxTailParagraphs: number;
	/** Number of tail sentences to inspect (fallback when paragraphs are not available) */
	maxTailSentences: number;
	/** Minimum repeat count to compress */
	minRepeatCount: number;
	/** Similarity threshold (0-1) after normalization */
	similarityThreshold: number;
	/** Maximum unit size to try when detecting repeated paragraph blocks */
	maxUnitParagraphs: number;
	/** Maximum unit size to try when detecting repeated sentence blocks */
	maxUnitSentences: number;
}

const DEFAULT_CONFIG: TailRepeatConfig = {
	enabled: true,
	maxTailParagraphs: 12,
	maxTailSentences: 40,
	minRepeatCount: 3,
	similarityThreshold: 0.9,
	maxUnitParagraphs: 4,
	maxUnitSentences: 6
};

export class TailRepeatCleaner implements TextCleaner {
	readonly name = 'TailRepeatCleaner';
	readonly enabled = true;

	private config: TailRepeatConfig;
	private logger = Logger.getLogger('TailRepeatCleaner');

	constructor(config?: Partial<TailRepeatConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) };
	}

	clean(text: string, language: string = 'auto', context?: CleaningContext): CleaningResult {
		if (!this.config.enabled) {
			return this.buildResult(text, text, []);
		}

		const enableDetailedLogging = context?.enableDetailedLogging ?? false;
		const original = this.normalizeNewlines(text).trim();
		if (!original) {
			return this.buildResult(text, text, []);
		}

		// 1) Prefer paragraph-level tail loop removal (higher confidence)
		const paragraphResult = this.compressRepeatedTailParagraphs(original, enableDetailedLogging);
		if (paragraphResult.changed) {
			return this.buildResult(text, paragraphResult.text, paragraphResult.patternsMatched);
		}

		// 2) Fallback: sentence-level tail loop removal (for single-paragraph endless loops)
		const sentenceResult = this.compressRepeatedTailSentences(original, language, enableDetailedLogging);
		if (sentenceResult.changed) {
			return this.buildResult(text, sentenceResult.text, sentenceResult.patternsMatched);
		}

		return this.buildResult(text, original, []);
	}

	private compressRepeatedTailParagraphs(
		text: string,
		enableDetailedLogging: boolean
	): { changed: boolean; text: string; patternsMatched: string[] } {
		const paragraphs = this.splitParagraphs(text);
		if (paragraphs.length < this.config.minRepeatCount) {
			return { changed: false, text, patternsMatched: [] };
		}

		const tailStart = Math.max(0, paragraphs.length - this.config.maxTailParagraphs);
		const prefix = paragraphs.slice(0, tailStart);
		const tail = paragraphs.slice(tailStart);
		const normalizedTail = tail.map(normalizeForComparison);

		const maxUnit = Math.min(
			this.config.maxUnitParagraphs,
			Math.floor(normalizedTail.length / this.config.minRepeatCount)
		);
		if (maxUnit <= 0) {
			return { changed: false, text, patternsMatched: [] };
		}

		const best = this.findBestTailRepeat(normalizedTail, maxUnit);
		if (!best) {
			return { changed: false, text, patternsMatched: [] };
		}

		const { unit, repeats, removedItems } = best;
		const tailLen = tail.length;
		const removeStart = tailLen - repeats * unit;
		const keepTailPrefix = tail.slice(0, removeStart);
		const keepPatternOnce = tail.slice(tailLen - unit);
		const newParagraphs = [...prefix, ...keepTailPrefix, ...keepPatternOnce];
		const cleanedText = newParagraphs.join('\n\n').trim();

		const patternsMatched = [
			`tail_paragraph_repeat: unit=${unit}, repeats=${repeats}, removed=${removedItems}`
		];
		if (enableDetailedLogging) {
			this.logger.debug('Compressed repeated tail paragraphs', {
				unit,
				repeats,
				removedItems
			});
		}

		return { changed: true, text: cleanedText, patternsMatched };
	}

	private compressRepeatedTailSentences(
		text: string,
		language: string,
		enableDetailedLogging: boolean
	): { changed: boolean; text: string; patternsMatched: string[] } {
		const sentences = splitIntoSentences(text, language);
		if (sentences.length < this.config.minRepeatCount) {
			return { changed: false, text, patternsMatched: [] };
		}

		const tailStart = Math.max(0, sentences.length - this.config.maxTailSentences);
		const prefix = sentences.slice(0, tailStart);
		const tail = sentences.slice(tailStart);
		const normalizedTail = tail.map(normalizeForComparison);

		const maxUnit = Math.min(
			this.config.maxUnitSentences,
			Math.floor(normalizedTail.length / this.config.minRepeatCount)
		);
		if (maxUnit <= 0) {
			return { changed: false, text, patternsMatched: [] };
		}

		const best = this.findBestTailRepeat(normalizedTail, maxUnit);
		if (!best) {
			return { changed: false, text, patternsMatched: [] };
		}

		const { unit, repeats, removedItems } = best;
		const tailLen = tail.length;
		const removeStart = tailLen - repeats * unit;
		const keepTailPrefix = tail.slice(0, removeStart);
		const keepPatternOnce = tail.slice(tailLen - unit);
		const cleanedText = [...prefix, ...keepTailPrefix, ...keepPatternOnce].join('').trim();

		const patternsMatched = [
			`tail_sentence_repeat: unit=${unit}, repeats=${repeats}, removed=${removedItems}`
		];
		if (enableDetailedLogging) {
			this.logger.debug('Compressed repeated tail sentences', {
				unit,
				repeats,
				removedItems
			});
		}

		return { changed: true, text: cleanedText, patternsMatched };
	}

	private findBestTailRepeat(
		normalizedTail: string[],
		maxUnit: number
	): { unit: number; repeats: number; removedItems: number } | null {
		let best: { unit: number; repeats: number; removedItems: number } | null = null;

		for (let unit = 1; unit <= maxUnit; unit++) {
			const repeats = this.countTailRepeats(normalizedTail, unit);
			if (repeats < this.config.minRepeatCount) {
				continue;
			}
			const removedItems = (repeats - 1) * unit;
			if (!best || removedItems > best.removedItems || (removedItems === best.removedItems && unit < best.unit)) {
				best = { unit, repeats, removedItems };
			}
		}

		return best;
	}

	private countTailRepeats(normalizedTail: string[], unit: number): number {
		const patternStart = normalizedTail.length - unit;
		const pattern = normalizedTail.slice(patternStart);
		let repeats = 1;

		for (;;) {
			const nextStart = normalizedTail.length - (repeats + 1) * unit;
			if (nextStart < 0) {
				break;
			}
			const candidate = normalizedTail.slice(nextStart, nextStart + unit);
			if (!this.areBlocksSimilar(candidate, pattern, this.config.similarityThreshold)) {
				break;
			}
			repeats++;
		}

		return repeats;
	}

	private areBlocksSimilar(a: string[], b: string[], threshold: number): boolean {
		if (a.length !== b.length) {
			return false;
		}
		for (let i = 0; i < a.length; i++) {
			const left = a[i] ?? '';
			const right = b[i] ?? '';
			if (!areSimilarNormalizedText(left, right, threshold)) {
				return false;
			}
		}
		return true;
	}

	private splitParagraphs(text: string): string[] {
		return text
			.split(/\n\s*\n+/)
			.map(p => p.trim())
			.filter(Boolean);
	}

	private normalizeNewlines(text: string): string {
		return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	}

	private buildResult(originalText: string, cleanedText: string, patternsMatched: string[]): CleaningResult {
		const originalLength = originalText.length;
		const cleanedLength = cleanedText.length;
		const reductionRatio = originalLength > 0 ? (originalLength - cleanedLength) / originalLength : 0;
		return {
			cleanedText,
			issues: [],
			hasSignificantChanges: reductionRatio > 0.01,
			metadata: {
				originalLength,
				cleanedLength,
				reductionRatio,
				...(patternsMatched.length > 0 && { patternsMatched })
			}
		};
	}
}
