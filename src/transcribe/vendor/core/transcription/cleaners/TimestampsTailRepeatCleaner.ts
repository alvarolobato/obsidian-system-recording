import { Logger } from '../../../utils/Logger';

import { areSimilarNormalizedText, normalizeForComparison } from './utils/TextSimilarity';

import type { TextCleaner, CleaningResult, CleaningContext } from './interfaces/TextCleaner';

export interface TimestampsTailRepeatConfig {
	enabled: boolean;
	maxTailBlocks: number;
	minRepeatCount: number;
	similarityThreshold: number;
	maxUnitBlocks: number;
	minTimestampedRatio: number;
}

const DEFAULT_CONFIG: TimestampsTailRepeatConfig = {
	enabled: true,
	maxTailBlocks: 30,
	minRepeatCount: 3,
	similarityThreshold: 0.9,
	maxUnitBlocks: 6,
	minTimestampedRatio: 0.7
};

const TIMESTAMP_PREFIX_REGEX = /^\[\d+:\d{2}\s*(?:→|->)\s*\d+:\d{2}\]\s*/u;

type TimestampBlock = {
	prefix: string;
	body: string;
	raw: string;
};

export class TimestampsTailRepeatCleaner implements TextCleaner {
	readonly name = 'TimestampsTailRepeatCleaner';
	readonly enabled = true;

	private config: TimestampsTailRepeatConfig;
	private logger = Logger.getLogger('TimestampsTailRepeatCleaner');

	constructor(config?: Partial<TimestampsTailRepeatConfig>) {
		this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) };
	}

	clean(text: string, _language: string = 'auto', context?: CleaningContext): CleaningResult {
		if (!this.config.enabled) {
			return this.buildResult(text, text, []);
		}

		const enableDetailedLogging = context?.enableDetailedLogging ?? false;
		const original = this.normalizeNewlines(text).trim();
		if (!original) {
			return this.buildResult(text, text, []);
		}

		const blocks = this.splitBlocks(original);
		const parsed = blocks.map(block => this.parseTimestampBlock(block));

		const lastTimestampedIndex = this.findLastTimestampedIndex(parsed);
		if (lastTimestampedIndex < 0) {
			return this.buildResult(text, original, []);
		}

		const blocksToAnalyze = parsed.slice(0, lastTimestampedIndex + 1);
		const trailingBlocks = parsed.slice(lastTimestampedIndex + 1);

		const tailStart = Math.max(0, blocksToAnalyze.length - this.config.maxTailBlocks);
		const head = blocksToAnalyze.slice(0, tailStart);
		const tail = blocksToAnalyze.slice(tailStart);

		const timestampedInTail = tail.filter(p => p.prefix.length > 0).length;
		if (timestampedInTail < this.config.minRepeatCount) {
			return this.buildResult(text, original, []);
		}

		const timestampedRatio = tail.length > 0 ? timestampedInTail / tail.length : 0;
		if (timestampedRatio < this.config.minTimestampedRatio) {
			return this.buildResult(text, original, []);
		}

		const normalizedTail = tail.map(block => normalizeForComparison(block.body));
		const maxUnit = Math.min(
			this.config.maxUnitBlocks,
			Math.floor(normalizedTail.length / this.config.minRepeatCount)
		);
		if (maxUnit <= 0) {
			return this.buildResult(text, original, []);
		}

		const best = this.findBestTailRepeat(normalizedTail, maxUnit);
		if (!best) {
			return this.buildResult(text, original, []);
		}

		const { unit, repeats, removedItems } = best;
		const tailLen = tail.length;
		const removeStart = tailLen - repeats * unit;
		const keepTailPrefix = tail.slice(0, removeStart);
		const keepPatternOnce = tail.slice(tailLen - unit);
		const newBlocks = [...head, ...keepTailPrefix, ...keepPatternOnce, ...trailingBlocks];
		const cleanedText = newBlocks.map(b => b.raw).join('\n').trim();

		const patternsMatched = [
			`timestamps_tail_repeat: unit=${unit}, repeats=${repeats}, removed=${removedItems}`
		];
		if (enableDetailedLogging) {
			this.logger.debug('Compressed repeated tail blocks (timestamps)', {
				unit,
				repeats,
				removedItems
			});
		}

		return this.buildResult(text, cleanedText, patternsMatched);
	}

	private splitBlocks(text: string): string[] {
		return text
			.split(/\n+/)
			.map(line => line.trim())
			.filter(Boolean);
	}

	private parseTimestampBlock(block: string): TimestampBlock {
		const match = block.match(TIMESTAMP_PREFIX_REGEX);
		if (!match) {
			return { prefix: '', body: block, raw: block };
		}

		const prefix = match[0];
		const body = block.slice(prefix.length).trimStart();
		return { prefix, body, raw: block };
	}

	private findLastTimestampedIndex(blocks: TimestampBlock[]): number {
		for (let i = blocks.length - 1; i >= 0; i--) {
			if (blocks[i]?.prefix.length) {
				return i;
			}
		}
		return -1;
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
