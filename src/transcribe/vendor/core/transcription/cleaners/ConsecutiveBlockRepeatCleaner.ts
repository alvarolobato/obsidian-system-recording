/**
 * Consecutive block repeat cleaner
 *
 * Compresses consecutive duplicated blocks anywhere in the transcript.
 * This targets "A B C A B C" style loops (often seen with GPT models) while
 * keeping false positives low by requiring a minimum normalized block length.
 */

import { Logger } from '../../../utils/Logger';

import { splitIntoSentences } from './utils/TextSegmentation';
import { normalizeForComparison } from './utils/TextSimilarity';

import type { TextCleaner, CleaningContext, CleaningResult } from './interfaces/TextCleaner';

export interface ConsecutiveBlockRepeatConfig {
	/** Enable consecutive block repeat compression */
	enabled: boolean;
	/** Minimum total normalized characters in a block to consider */
	minBlockNormalizedChars: number;
	/** Maximum sentence unit size to try */
	maxUnitSentences: number;
	/** Allow compressing repeated single long sentences */
	allowSingleSentence: boolean;
}

const DEFAULT_CONFIG: ConsecutiveBlockRepeatConfig = {
	enabled: true,
	minBlockNormalizedChars: 80,
	maxUnitSentences: 12,
	allowSingleSentence: true
};

export class ConsecutiveBlockRepeatCleaner implements TextCleaner {
	readonly name = 'ConsecutiveBlockRepeatCleaner';
	readonly enabled = true;

	private config: ConsecutiveBlockRepeatConfig;
	private logger = Logger.getLogger('ConsecutiveBlockRepeatCleaner');

	constructor(config?: Partial<ConsecutiveBlockRepeatConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) };
	}

	clean(text: string, language: string = 'auto', context?: CleaningContext): CleaningResult {
		if (!this.config.enabled) {
			return this.buildResult(text, text, []);
		}

		const enableDetailedLogging = context?.enableDetailedLogging ?? false;
		const original = this.normalizeNewlines(text);
		if (!original.trim()) {
			return this.buildResult(text, text, []);
		}

		const sentences = splitIntoSentences(original, language);
		if (sentences.length < 2) {
			const fallback = this.compressConsecutiveNormalizedTextBlocks(original, enableDetailedLogging);
			if (!fallback.changed) {
				return this.buildResult(text, original, []);
			}
			return this.buildResult(text, fallback.text, fallback.patternsMatched);
		}

		const normalizedSentences = sentences.map(normalizeForComparison);
		const patternsMatched: string[] = [];
		const output: string[] = [];

		let i = 0;
		while (i < sentences.length) {
			const maxUnit = Math.min(
				this.config.maxUnitSentences,
				Math.floor((sentences.length - i) / 2)
			);
			const minUnit = this.config.allowSingleSentence ? 1 : 2;

			let best: { unit: number; repeats: number; removedNormalizedChars: number } | null = null;
			for (let unit = maxUnit; unit >= minUnit; unit--) {
				const blockChars = this.getBlockNormalizedLength(normalizedSentences, i, unit);
				if (blockChars < this.config.minBlockNormalizedChars) {
					continue;
				}

				const repeats = this.countRepeats(normalizedSentences, i, unit);
				if (repeats < 2) {
					continue;
				}

				const removedNormalizedChars = (repeats - 1) * blockChars;
				if (
					!best ||
					removedNormalizedChars > best.removedNormalizedChars ||
					(removedNormalizedChars === best.removedNormalizedChars && unit > best.unit)
				) {
					best = { unit, repeats, removedNormalizedChars };
				}
			}

			if (best) {
				output.push(...sentences.slice(i, i + best.unit));
				patternsMatched.push(`consecutive_block_repeat: unit=${best.unit}, repeats=${best.repeats}`);
				i += best.unit * best.repeats;
				continue;
			}

			output.push(sentences[i] ?? '');
			i++;
		}

		let cleanedText = output.join('');

		const textBlockCompression = this.compressConsecutiveNormalizedTextBlocks(cleanedText, enableDetailedLogging);
		if (textBlockCompression.changed) {
			cleanedText = textBlockCompression.text;
			patternsMatched.push(...textBlockCompression.patternsMatched);
		}

		if (cleanedText === original) {
			return this.buildResult(text, original, []);
		}

		if (enableDetailedLogging) {
			this.logger.debug('Compressed consecutive duplicated blocks', {
				compressions: patternsMatched.length,
				removedChars: original.length - cleanedText.length
			});
		}

		return this.buildResult(text, cleanedText, patternsMatched);
	}

	private countRepeats(normalized: string[], start: number, unit: number): number {
		let repeats = 1;
		for (;;) {
			const nextStart = start + repeats * unit;
			if (nextStart + unit > normalized.length) {
				break;
			}
			if (!this.areBlocksEqual(normalized, start, nextStart, unit)) {
				break;
			}
			repeats++;
		}
		return repeats;
	}

	private areBlocksEqual(normalized: string[], aStart: number, bStart: number, unit: number): boolean {
		for (let i = 0; i < unit; i++) {
			if ((normalized[aStart + i] ?? '') !== (normalized[bStart + i] ?? '')) {
				return false;
			}
		}
		return true;
	}

	private getBlockNormalizedLength(normalized: string[], start: number, unit: number): number {
		let total = 0;
		for (let i = 0; i < unit; i++) {
			total += (normalized[start + i] ?? '').length;
		}
		return total;
	}

	private normalizeNewlines(text: string): string {
		return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	}

	private compressConsecutiveNormalizedTextBlocks(
		text: string,
		enableDetailedLogging: boolean
	): { changed: boolean; text: string; patternsMatched: string[] } {
		// Covers repeats that are not aligned with sentence segmentation (e.g., chunk boundary cuts).
		// Uses a normalized-text representation with an index map to safely remove repeats from the original string.
		const minLen = Math.max(20, this.config.minBlockNormalizedChars);
		const maxLenCap = 1000;

		const normalized = this.normalizeForComparisonWithIndexMap(text);
		if (normalized.normalized.length < minLen * 2) {
			return { changed: false, text, patternsMatched: [] };
		}

		const { prefix, pow } = this.buildRollingHash(normalized.normalized);
		const prefixLen = Math.min(20, Math.max(8, Math.floor(minLen / 4)));
		const patternsMatched: string[] = [];
		const removalRanges: Array<{ start: number; end: number }> = [];

		let i = 0;
		while (i <= normalized.normalized.length - minLen * 2) {
			const remaining = normalized.normalized.length - i;
			const maxLen = Math.min(maxLenCap, Math.floor(remaining / 2));
			if (maxLen < minLen) {
				break;
			}

			const prefixHash = this.substringHash(prefix, pow, i, i + prefixLen);
			let best: { unit: number; repeats: number; removed: number } | null = null;

			for (let unit = minLen; unit <= maxLen; unit++) {
				if (this.substringHash(prefix, pow, i + unit, i + unit + prefixLen) !== prefixHash) {
					continue;
				}
				if (!this.areNormalizedSubstringsEqual(normalized.normalized, prefix, pow, i, i + unit, unit)) {
					continue;
				}

				let repeats = 2;
				for (;;) {
					const nextStart = i + repeats * unit;
					if (nextStart + unit > normalized.normalized.length) {
						break;
					}
					if (!this.areNormalizedSubstringsEqual(normalized.normalized, prefix, pow, i, nextStart, unit)) {
						break;
					}
					repeats++;
				}

				const requiredRepeats = unit >= 160 ? 2 : 3;
				if (repeats < requiredRepeats) {
					continue;
				}

				const removed = (repeats - 1) * unit;
				if (!best || removed > best.removed || (removed === best.removed && unit > best.unit)) {
					best = { unit, repeats, removed };
				}
			}

			if (best) {
				const startNorm = i + best.unit;
				const endNormExclusive = i + best.unit * best.repeats;
				const startOrigRaw = normalized.indexMap[startNorm];
				const endOrigRaw = normalized.indexMap[endNormExclusive - 1];

				if (startOrigRaw !== undefined && endOrigRaw !== undefined) {
					let startOrig = startOrigRaw;
					while (startOrig > 0 && /\s/u.test(text[startOrig - 1] ?? '')) {
						startOrig--;
					}

					let endOrig = endOrigRaw + 1;
					while (endOrig < text.length && /\s/u.test(text[endOrig] ?? '')) {
						endOrig++;
					}

					if (startOrig < endOrig) {
						removalRanges.push({ start: startOrig, end: endOrig });
						patternsMatched.push(
							`consecutive_text_block_repeat: len=${best.unit}, repeats=${best.repeats}`
						);
					}
				}

				i += best.unit * best.repeats;
				continue;
			}

			i++;
		}

		if (removalRanges.length === 0) {
			return { changed: false, text, patternsMatched: [] };
		}

		removalRanges.sort((a, b) => a.start - b.start);
		const mergedRanges: Array<{ start: number; end: number }> = [];
		for (const range of removalRanges) {
			const last = mergedRanges[mergedRanges.length - 1];
			if (!last || range.start > last.end) {
				mergedRanges.push({ ...range });
				continue;
			}
			last.end = Math.max(last.end, range.end);
		}

		let out = '';
		let cursor = 0;
		for (const range of mergedRanges) {
			out += text.slice(cursor, range.start);
			cursor = range.end;
		}
		out += text.slice(cursor);

		if (enableDetailedLogging && out !== text) {
			const removedChars = text.length - out.length;
			this.logger.debug('Compressed consecutive duplicated text blocks', {
				compressions: mergedRanges.length,
				removedChars
			});
		}

		return { changed: out !== text, text: out, patternsMatched };
	}

	private normalizeForComparisonWithIndexMap(text: string): { normalized: string; indexMap: number[] } {
		const indexMap: number[] = [];
		let out = '';

		for (let i = 0; i < text.length; i++) {
			const originalChar = text[i];
			if (!originalChar) {
				continue;
			}

			const nfkc = originalChar.normalize('NFKC');
			for (const rawChar of nfkc) {
				let ch = rawChar.toLowerCase();
				if (!ch) {
					continue;
				}

				// Unify katakana to hiragana for comparison
				const code = ch.charCodeAt(0);
				if (code >= 0x30A1 && code <= 0x30F6) {
					ch = String.fromCharCode(code - 0x60);
				}

				// Drop whitespace / punctuation / symbols / format controls (e.g., zero-width chars)
				if (/[\p{White_Space}\p{P}\p{S}\p{Cf}]/u.test(ch)) {
					continue;
				}

				out += ch;
				indexMap.push(i);
			}
		}

		return { normalized: out, indexMap };
	}

	private buildRollingHash(text: string): { prefix: Uint32Array; pow: Uint32Array } {
		const BASE = 911382323;
		const prefix = new Uint32Array(text.length + 1);
		const pow = new Uint32Array(text.length + 1);
		pow[0] = 1;

		for (let i = 0; i < text.length; i++) {
			const prev = prefix[i] ?? 0;
			const code = text.charCodeAt(i) + 1;
			prefix[i + 1] = (Math.imul(prev, BASE) + code) >>> 0;
			pow[i + 1] = Math.imul(pow[i] ?? 1, BASE) >>> 0;
		}

		return { prefix, pow };
	}

	private substringHash(prefix: Uint32Array, pow: Uint32Array, start: number, end: number): number {
		if (start < 0 || end <= start) {
			return 0;
		}
		const len = end - start;
		const hash = (prefix[end] ?? 0) - Math.imul(prefix[start] ?? 0, pow[len] ?? 1);
		return hash >>> 0;
	}

	private areNormalizedSubstringsEqual(
		text: string,
		prefix: Uint32Array,
		pow: Uint32Array,
		aStart: number,
		bStart: number,
		len: number
	): boolean {
		if (this.substringHash(prefix, pow, aStart, aStart + len) !== this.substringHash(prefix, pow, bStart, bStart + len)) {
			return false;
		}
		// Hash collision safety: confirm equality only when hashes match.
		return text.slice(aStart, aStart + len) === text.slice(bStart, bStart + len);
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
				patternsMatched
			}
		};
	}
}
