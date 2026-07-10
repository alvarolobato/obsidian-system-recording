/**
 * Handles merging of transcription results
 * Provides different strategies for combining chunk results
 */

import { getModelConfig } from '../../config/ModelProcessingConfig';
import { Logger } from '../../utils/Logger';
import { OverlapAnalyzer } from '../utils/OverlapAnalyzer';
import { OverlapDebugger } from '../utils/OverlapDebugger';

import {
	buildNGramIndex,
	findPotentialMatches,
	getOptimalNGramSize,
	calculateNormalizedNGramSimilarity
} from './utils/TextSimilarity';

import type { TranscriptionResult, TranscriptionSegment } from './TranscriptionTypes';
import type { ModelConfig } from '../../config/ModelProcessingConfig';

export interface MergeOptions {
	/** Remove duplicate content from overlaps */
	removeOverlaps: boolean;
	/** Minimum characters to consider as duplicate */
	minMatchLength: number;
	/** Use timestamps for alignment */
	useTimestamps: boolean;
	/** Separator for simple concatenation */
	separator: string;
	/** Include failed chunk information */
	includeFailures: boolean;
}

export class TranscriptionMerger {
	private defaultOptions: MergeOptions;
	private mergingConfig: ModelConfig['merging'];
	private modelConfig: ModelConfig;
	private logger: Logger;

	constructor(modelName: string) {
		this.logger = Logger.getLogger('TranscriptionMerger');

		// Get model-specific merging config
		const modelConfig = getModelConfig(modelName);
		this.modelConfig = modelConfig;
		this.mergingConfig = modelConfig.merging;

		const minMatchLength = this.mergingConfig.minMatchLength ?? 20;
		this.defaultOptions = {
			removeOverlaps: true,
			minMatchLength,
			useTimestamps: true,
			separator: '\n\n',
			includeFailures: true
		};

		const overlapDetection = this.mergingConfig.overlapDetection;
		this.logger.debug('TranscriptionMerger initialized', {
			modelName,
			fuzzyMatchSimilarity: this.mergingConfig.fuzzyMatchSimilarity ?? 0.8,
			minMatchLength: this.mergingConfig.minMatchLength,
			useNGramScreening: this.mergingConfig.useNGramScreening !== false,
			overlapDetection: overlapDetection
				? {
						minOverlapLength: overlapDetection.minOverlapLength,
						maxOverlapLength: overlapDetection.maxOverlapLength,
						searchRangeInNext: overlapDetection.searchRangeInNext,
						candidateStepSize: overlapDetection.candidateStepSize,
						similarityThreshold: overlapDetection.similarityThreshold
					}
				: null
		});
	}

	/**
	 * Merge transcription results with simple concatenation
	 */
	simpleMerge(
		results: TranscriptionResult[],
		separator: string = '\n\n'
	): string {
		const validResults = results.filter(r => r.success);
		return validResults.map(r => r.text).join(separator);
	}

	/**
	 * Merge with overlap removal (for Whisper-style processing)
	 */
	mergeWithOverlapRemoval(
		results: TranscriptionResult[],
		options: Partial<MergeOptions> = {}
	): string {
		const startTime = performance.now();
		const opts = { ...this.defaultOptions, ...options };

		this.logger.debug('Starting overlap removal merge', {
			resultCount: results.length,
			removeOverlaps: opts.removeOverlaps
		});

		// Separate valid and failed results
		const validResults = results.filter(r => r.success);
		const failedResults = results.filter(r => !r.success);

		if (validResults.length === 0) {
			return this.formatFailures(failedResults);
		}

		// Sort by start time
		validResults.sort((a, b) => a.startTime - b.startTime);

		// Merge with overlap detection
		const firstResult = validResults[0];
		if (!firstResult) {
			return this.formatFailures(failedResults);
		}
		let mergedText = firstResult.text;

		for (let i = 1; i < validResults.length; i++) {
			const previous = validResults[i - 1];
			const current = validResults[i];
			if (!previous || !current) {
				continue;
			}

			// Analyze the overlap problem
			OverlapAnalyzer.analyzeOverlapProblem(
				previous.endTime,
				current.startTime,
				mergedText,
				current.text,
				this.modelConfig
			);

			// Calculate overlap duration
			const overlapStart = Math.max(previous.startTime, current.startTime);
			const overlapEnd = Math.min(previous.endTime, current.endTime);
			const overlapDuration = Math.max(0, overlapEnd - overlapStart);

			if (overlapDuration > 0 && opts.removeOverlaps) {
				// Find and remove overlap
				const overlap = this.findOverlap(
					mergedText,
					current.text,
					overlapDuration,
					opts.minMatchLength
				);

				const connector = overlap.matchFound ? overlap.connector : opts.separator;
				if (!overlap.matchFound) {
					this.logger.warn('Overlap expected but no match found; keeping separator', {
						overlapDuration,
						previousTextLength: mergedText.length,
						currentTextLength: current.text.length,
						minMatchLength: opts.minMatchLength
					});
				}
				mergedText += connector + overlap.trimmedText;
			} else {
				// No overlap, simple concatenation
				mergedText += opts.separator + current.text;
			}
		}

		// Add failure information if requested
		if (opts.includeFailures && failedResults.length > 0) {
			mergedText += '\n\n---\n' + this.formatFailures(failedResults);
		}

		// Apply duplicate removal if enabled
		// Note: For GPT-4o, this is disabled as overlap removal in findOverlap handles 150-500 char duplicates
		if (this.mergingConfig.duplicateRemoval?.enabled) {
			const minLength = this.mergingConfig.duplicateRemoval.minDuplicateLength || 150;
			mergedText = this.detectAndRemoveAllDuplicates(mergedText, minLength);
		}

		const elapsedTime = performance.now() - startTime;
		this.logger.info('Overlap removal merge completed', {
			elapsedTime: `${elapsedTime.toFixed(2)}ms`,
			validResults: validResults.length,
			failedResults: failedResults.length,
			finalTextLength: mergedText.length
		});

		return mergedText.trim();
	}

	/**
	 * Merge using timestamp alignment (for precise segment-based merging)
	 */
	mergeWithTimestamps(
		results: TranscriptionResult[],
		options: Partial<MergeOptions> = {}
	): string {
		const opts = { ...this.defaultOptions, ...options };
		const validResults = results.filter(r => r.success && r.segments);

		if (validResults.length === 0) {
			return this.simpleMerge(results, opts.separator);
		}

		// Collect all segments
		const allSegments: TranscriptionSegment[] = [];
		for (const result of validResults) {
			if (result.segments) {
				allSegments.push(...result.segments);
			}
		}

		// Sort by start time
		allSegments.sort((a, b) => a.start - b.start);

		// Remove overlapping segments
		const mergedSegments = this.deduplicateSegments(allSegments);

		// Join segment texts
		let mergedText = mergedSegments.map(s => s.text).join(' ').trim();

		// Apply duplicate removal if enabled
		// Note: For GPT-4o, this is disabled as overlap removal in findOverlap handles 150-500 char duplicates
		if (this.mergingConfig.duplicateRemoval?.enabled) {
			const minLength = this.mergingConfig.duplicateRemoval.minDuplicateLength || 150;


			mergedText = this.detectAndRemoveAllDuplicates(mergedText, minLength);
		}

		return mergedText;
	}

	/**
	 * Find overlapping content between two texts
	 */
	private findOverlap(
		previousText: string,
		currentText: string,
		overlapDuration: number,
		minMatchLength: number
	): { trimmedText: string; connector: string; matchFound: boolean } {
		// Get overlap detection settings from config
		const overlapConfig = this.mergingConfig.overlapDetection ?? {
			minOverlapLength: 150,
			maxOverlapLength: 500,
			searchRangeInNext: 2000,
			candidateStepSize: 10,
			similarityThreshold: 0.85
		};

		const MIN_OVERLAP = overlapConfig.minOverlapLength;
		const MAX_OVERLAP = overlapConfig.maxOverlapLength;
		const SEARCH_RANGE = overlapConfig.searchRangeInNext;
		const STEP_SIZE = overlapConfig.candidateStepSize;
		const SIMILARITY_THRESHOLD = overlapConfig.similarityThreshold;
		const residualMinOverlap = Math.max(20, minMatchLength);

			// Validate inputs
			if (!previousText || !currentText) {
				this.logger.warn('Empty text provided to findOverlap');
				return { trimmedText: currentText || '', connector: ' ', matchFound: false };
			}

		// Debug logging using OverlapDebugger
		OverlapDebugger.logOverlapDetection(
			previousText,
			currentText,
			overlapDuration,
			this.mergingConfig.estimatedCharsPerSecond ?? 15,
			minMatchLength
		);

		// まずは「境界近傍の最長完全一致」を探す（軽いブレがあっても、どこかに長い一致が残ることが多い）
		// - 末尾に追加文があり overlap が suffix に届かないケースに強い
		// - candidateStepSize の粒度に依存しない
		const exactOverlap = this.findExactOverlapFallback(
			previousText,
			currentText,
			MIN_OVERLAP,
			MAX_OVERLAP,
			SEARCH_RANGE
		);
		if (exactOverlap) {
			const cleanedText = this.trimResidualOverlapAtBoundary(
				previousText,
				exactOverlap.trimmedText,
				residualMinOverlap,
				MAX_OVERLAP,
				SEARCH_RANGE
			);
			return { trimmedText: cleanedText, connector: exactOverlap.connector, matchFound: true };
		}

		// 正規化（空白/句読点除去）した上で「境界近傍の最長完全一致」を探す
		// - 句読点や改行の差分で完全一致が途切れるケースに強い
		const normalizedExactOverlap = this.findNormalizedExactOverlapFallback(
			previousText,
			currentText,
			MIN_OVERLAP,
			MAX_OVERLAP,
			SEARCH_RANGE
		);
			if (normalizedExactOverlap) {
				const cleanedText = this.trimResidualOverlapAtBoundary(
					previousText,
					normalizedExactOverlap.trimmedText,
					residualMinOverlap,
					MAX_OVERLAP,
					SEARCH_RANGE
				);
				return { trimmedText: cleanedText, connector: normalizedExactOverlap.connector, matchFound: true };
			}

			// NOTE: Some models follow the prompt well and only repeat a short overlap at the boundary.
			// If the configured MIN_OVERLAP is too high (or not loaded), fall back to a shorter threshold
			// but keep boundary constraints strict to avoid false positives.
			const softMinOverlap = Math.max(20, minMatchLength);
			if (softMinOverlap < MIN_OVERLAP) {
				const exactSoft = this.findExactOverlapFallback(
					previousText,
					currentText,
					softMinOverlap,
					MAX_OVERLAP,
					SEARCH_RANGE,
					{
						maxLeadingGapInCurrent: 250,
						maxTrailingGapInPrevious: 200
					}
				);
				if (exactSoft) {
					const cleanedText = this.trimResidualOverlapAtBoundary(
						previousText,
						exactSoft.trimmedText,
						residualMinOverlap,
						MAX_OVERLAP,
						SEARCH_RANGE
					);
					return { trimmedText: cleanedText, connector: exactSoft.connector, matchFound: true };
				}

				const normalizedSoft = this.findNormalizedExactOverlapFallback(
					previousText,
					currentText,
					softMinOverlap,
					MAX_OVERLAP,
					SEARCH_RANGE,
					{
						maxLeadingGapInCurrent: 250,
						maxTrailingGapInPrevious: 200
					}
				);
				if (normalizedSoft) {
					const cleanedText = this.trimResidualOverlapAtBoundary(
						previousText,
						normalizedSoft.trimmedText,
						residualMinOverlap,
						MAX_OVERLAP,
						SEARCH_RANGE
					);
					return { trimmedText: cleanedText, connector: normalizedSoft.connector, matchFound: true };
				}
			}

			// 長い候補から短い候補へ順に試す（より多くの重複を除去するため）
			for (let candidateLength = MAX_OVERLAP; candidateLength >= MIN_OVERLAP; candidateLength -= STEP_SIZE) {
				// 前のチャンクの末尾から候補テキストを抽出
				const candidateStart = Math.max(0, previousText.length - candidateLength);
			const candidateText = previousText.slice(candidateStart);

			// 候補が短すぎる場合はスキップ
			if (candidateText.length < MIN_OVERLAP) {
				continue;
			}

			// 次のチャンクの最初の1000文字内ですべての一致を検索
			const matches = this.findAllMatchesInRange(
				candidateText,
				currentText,
				0,  // 検索開始位置
				Math.min(SEARCH_RANGE, currentText.length),  // 検索終了位置
				SIMILARITY_THRESHOLD
			);

			if (matches.length > 0) {
				// Log match details
				const lastMatch = matches[matches.length - 1];
				if (!lastMatch) {
					continue;
				}
					OverlapDebugger.logMatchFound({
						kind: 'ngram',
						matchLength: lastMatch.length,
						matchPositionInPrevious: previousText.length - candidateLength, // previous start position
						matchPositionInCurrent: lastMatch.position,
						similarity: lastMatch.similarity
					});

				if (matches.length > 1) {
					this.logger.debug('Multiple overlap matches detected', {
						matchCount: matches.length,
						candidateLength
					});
				}

				const matchEndInCurrent = lastMatch.position + lastMatch.length;
				const rawAfterMatch = currentText.slice(matchEndInCurrent);
				const rawTrimmedText = rawAfterMatch.trimStart();
				const connector = this.determineInlineConnector(previousText, rawAfterMatch);

				const trimmedText = this.trimResidualOverlapAtBoundary(
					previousText,
					rawTrimmedText,
					residualMinOverlap,
					MAX_OVERLAP,
					SEARCH_RANGE
				);

				OverlapDebugger.logFinalResult(trimmedText, connector);
				return { trimmedText, connector, matchFound: true };
			}
		}

			OverlapDebugger.logNoMatchFound();
			return {
				trimmedText: currentText,
				connector: ' ',
				matchFound: false
			};
		}

		// すべての一致を検索するヘルパーメソッド
		private findAllMatchesInRange(
			candidateText: string,
			searchText: string,
		searchStart: number,
		searchEnd: number,
		similarityThreshold: number
	): Array<{ position: number; length: number; similarity: number }> {
		const matches: Array<{ position: number; length: number; similarity: number }> = [];
		const candidateLength = candidateText.length;

		// n-gramサイズを動的に決定（短いテキストには小さいn-gram）
		const nGramSize = getOptimalNGramSize(candidateLength, 'overlap');

		// スライディングウィンドウで検索
		for (let pos = searchStart; pos <= searchEnd - candidateLength; pos++) {
			const targetText = searchText.slice(pos, pos + candidateLength);

			// 正規化してn-gram類似度を計算
				const similarity = calculateNormalizedNGramSimilarity(
					candidateText,
					targetText,
					nGramSize,
					{
						removeSpaces: true,
						removePunctuation: true,
						unifyKana: true,
						toLowerCase: true
						}
				);

			if (similarity >= similarityThreshold) {
				matches.push({ position: pos, length: candidateLength, similarity });

				// 次の検索は現在の一致の後から開始（重複を避ける）
				// Skip forward by a configurable ratio to avoid overlapping matches
				const skipRatio = this.mergingConfig.overlapDetection?.matchSkipRatio ?? 0.5;
				pos += Math.floor(candidateLength * skipRatio);
			}
		}

		return matches;
	}

		private determineInlineConnector(previousText: string, nextTextRaw: string): string {
			const previousTrimmed = previousText.trimEnd();
			if (!previousTrimmed) {
				return '';
			}
			if (/[\s\u3000]$/.test(previousText)) {
				return '';
			}
			if (!nextTextRaw) {
				return '';
			}

			const nextTrimmed = nextTextRaw.trimStart();
			if (nextTrimmed.length === 0) {
				return '';
			}

			const hadLeadingWhitespace = nextTextRaw.length !== nextTrimmed.length;
			if (!hadLeadingWhitespace) {
				return '';
			}

			// Preserve a single space between ASCII-ish tokens when the model emitted whitespace.
			const previousLastSignificant = this.getLastSignificantChar(previousTrimmed);
			const nextFirst = nextTrimmed[0];
			if (!previousLastSignificant || !nextFirst) {
				return '';
			}

			const nextStartsAsciiWord = /[A-Za-z0-9]/.test(nextFirst);
			if (!nextStartsAsciiWord) {
				return '';
			}

			const previousAsciiWordOrPunct = /[A-Za-z0-9.,!?;:]/.test(previousLastSignificant);
			return previousAsciiWordOrPunct ? ' ' : '';
		}

		private getLastSignificantChar(text: string): string | null {
			let index = text.length - 1;
			while (index >= 0) {
				const char = text[index];
				if (!char) {
					index--;
					continue;
				}
				if (/[\s\u3000]/.test(char)) {
					index--;
					continue;
				}
				break;
			}

			while (index >= 0) {
				const char = text[index];
				if (!char) {
					index--;
					continue;
				}
				if (/[」』”’"'）)\]】〉》〕］}]/.test(char)) {
					index--;
					continue;
				}
				break;
			}

			if (index < 0) {
				return null;
			}
			return text[index] ?? null;
		}

	private trimResidualOverlapAtBoundary(
		previousText: string,
		currentText: string,
		minOverlapLength: number,
		maxOverlapLength: number,
		searchRangeInNext: number
	): string {
		// 1回のtrimで取り切れない「残りかす」の重複を、境界上でもう一度だけ落とす
		// 例: current側で同じフレーズが2回繰り返された場合に、1回目の一致でtrimしても2回目が残ることがある
		const originalLength = currentText.length;
		let trimmed = currentText;
		for (let pass = 0; pass < 2; pass++) {
			const beforeLength = trimmed.length;
			const exact = this.findExactOverlapFallback(
				previousText,
				trimmed,
				minOverlapLength,
				maxOverlapLength,
				searchRangeInNext
			);
			if (exact && exact.trimmedText.length < trimmed.length) {
				trimmed = exact.trimmedText;
				this.logger.debug('Residual overlap trimmed (exact)', {
					pass: pass + 1,
					beforeLength,
					afterLength: trimmed.length,
					removedChars: beforeLength - trimmed.length
				});
				continue;
			}

			const normalized = this.findNormalizedExactOverlapFallback(
				previousText,
				trimmed,
				minOverlapLength,
				maxOverlapLength,
				searchRangeInNext
			);
			if (normalized && normalized.trimmedText.length < trimmed.length) {
				trimmed = normalized.trimmedText;
				this.logger.debug('Residual overlap trimmed (normalizedExact)', {
					pass: pass + 1,
					beforeLength,
					afterLength: trimmed.length,
					removedChars: beforeLength - trimmed.length
				});
				continue;
			}

			break;
		}

		if (trimmed.length < originalLength) {
			this.logger.debug('Residual overlap trimming complete', {
				originalLength,
				finalLength: trimmed.length,
				totalRemovedChars: originalLength - trimmed.length
			});
		}

		return trimmed;
	}

		private findExactOverlapFallback(
			previousText: string,
			currentText: string,
			minOverlapLength: number,
			maxOverlapLength: number,
			searchRangeInNext: number,
			options?: {
				maxLeadingGapInCurrent?: number;
				maxTrailingGapInPrevious?: number;
			}
		): { trimmedText: string; connector: string } | null {
		// If the fuzzy suffix-based match fails, try an exact longest-common-substring match
		// within the previous tail and current head windows. This helps when the overlap exists
		// but does not reach the very end of the previous chunk due to transcription drift.
		// Keep this threshold configurable (via overlapDetection.minOverlapLength).
		// We also apply strict positional constraints to reduce false positives.
			const minExactLength = Math.max(20, minOverlapLength);
			const tailWindow = Math.min(previousText.length, Math.max(500, maxOverlapLength));
			const headWindow = Math.min(currentText.length, Math.max(500, searchRangeInNext));

		const previousTailStart = Math.max(0, previousText.length - tailWindow);
		const previousTail = previousText.slice(previousTailStart);
		const currentHead = currentText.slice(0, headWindow);

		// Guardrails to reduce false positives:
		// - The match must be near the beginning of the current chunk text
		// - The match must be near the end of the previous chunk text
			const maxLeadingGapInCurrent = options?.maxLeadingGapInCurrent ?? Math.max(60, Math.floor(headWindow * 0.25));
			const maxTrailingGapInPrevious = options?.maxTrailingGapInPrevious ?? Math.max(200, Math.floor(tailWindow * 0.8));

		const match = this.findLongestCommonSubstringWithConstraints(previousTail, currentHead, {
			minLength: minExactLength,
			maxStartInText2: maxLeadingGapInCurrent,
			minEndInText1: Math.max(0, previousTail.length - maxTrailingGapInPrevious)
		});
		if (!match) {
			return null;
		}

		const positionInPrevious = previousTailStart + match.positionInText1;
		const positionInCurrent = match.positionInText2;
		const matchEndInPrevious = positionInPrevious + match.length;
		const trailingGapInPrevious = previousText.length - matchEndInPrevious;

			OverlapDebugger.logMatchFound({
				kind: 'exact',
				matchLength: match.length,
				matchPositionInPrevious: positionInPrevious,
				matchPositionInCurrent: positionInCurrent
			});

		const matchEndInCurrent = positionInCurrent + match.length;
		const rawAfterMatch = currentText.slice(matchEndInCurrent);
		const trimmedText = rawAfterMatch.trimStart();
		const connector = this.determineInlineConnector(previousText, rawAfterMatch);
		this.logger.debug('Exact overlap match used', {
			matchLength: match.length,
			positionInPrevious,
			positionInCurrent,
			trailingGapInPrevious,
			tailWindow,
			headWindow,
			trimAdvance: 0
		});
		OverlapDebugger.logFinalResult(trimmedText, connector);
		return { trimmedText, connector };
	}

		private findNormalizedExactOverlapFallback(
			previousText: string,
			currentText: string,
			minOverlapLength: number,
			maxOverlapLength: number,
			searchRangeInNext: number,
			options?: {
				maxLeadingGapInCurrent?: number;
				maxTrailingGapInPrevious?: number;
			}
		): { trimmedText: string; connector: string } | null {
			const minExactLength = Math.max(20, minOverlapLength);
			const tailWindow = Math.min(previousText.length, Math.max(500, maxOverlapLength));
			const headWindow = Math.min(currentText.length, Math.max(500, searchRangeInNext));

		const previousTailStart = Math.max(0, previousText.length - tailWindow);
		const previousTail = previousText.slice(previousTailStart);
		const currentHead = currentText.slice(0, headWindow);

		const normalization = {
			removeSpaces: true,
			removePunctuation: true,
			unifyKana: true,
			toLowerCase: true
		} as const;

		const previousNormalized = this.normalizeTextWithIndexMap(previousTail, normalization);
		const currentNormalized = this.normalizeTextWithIndexMap(currentHead, normalization);
		if (previousNormalized.normalized.length === 0 || currentNormalized.normalized.length === 0) {
			return null;
		}

			const maxLeadingGapInCurrent = options?.maxLeadingGapInCurrent ?? Math.max(60, Math.floor(headWindow * 0.25));
			const maxTrailingGapInPrevious = options?.maxTrailingGapInPrevious ?? Math.max(200, Math.floor(tailWindow * 0.8));

		const match = this.findLongestCommonSubstringWithConstraints(
			previousNormalized.normalized,
			currentNormalized.normalized,
			{
				minLength: minExactLength,
				maxStartInText2: maxLeadingGapInCurrent,
				minEndInText1: Math.max(0, previousNormalized.normalized.length - maxTrailingGapInPrevious)
			}
		);
		if (!match) {
			return null;
		}

		const originalMatchStartInCurrent = currentNormalized.indexMap[match.positionInText2];
		const originalMatchEndInCurrent = currentNormalized.indexMap[match.positionInText2 + match.length - 1];
		const originalMatchStartInPrevious = previousNormalized.indexMap[match.positionInText1];
		const originalMatchEndInPrevious = previousNormalized.indexMap[match.positionInText1 + match.length - 1];
		if (
			originalMatchStartInCurrent === undefined ||
			originalMatchEndInCurrent === undefined ||
			originalMatchStartInPrevious === undefined ||
			originalMatchEndInPrevious === undefined
		) {
			return null;
		}

		const positionInPrevious = previousTailStart + originalMatchStartInPrevious;
		const positionInCurrent = originalMatchStartInCurrent;
		const matchEndInPrevious = previousTailStart + originalMatchEndInPrevious + 1;
		const trailingGapInPrevious = previousText.length - matchEndInPrevious;

			OverlapDebugger.logMatchFound({
				kind: 'normalizedExact',
				matchLength: match.length,
				matchPositionInPrevious: positionInPrevious,
				matchPositionInCurrent: positionInCurrent
			});

		const rawMatchEndInCurrentExclusive = this.advancePastSkippableChars(
			currentText,
			originalMatchEndInCurrent + 1,
			normalization
		);
		const rawAfterMatch = currentText.slice(rawMatchEndInCurrentExclusive);
		const trimmedText = rawAfterMatch.trimStart();
		const connector = this.determineInlineConnector(previousText, rawAfterMatch);

		this.logger.debug('Normalized exact overlap match used', {
			matchLength: match.length,
			positionInPrevious,
			positionInCurrent,
			trailingGapInPrevious,
			tailWindow,
			headWindow,
			trimAdvance: rawMatchEndInCurrentExclusive - (originalMatchEndInCurrent + 1)
		});
		OverlapDebugger.logFinalResult(trimmedText, connector);
		return { trimmedText, connector };
	}

		private normalizeTextWithIndexMap(
			text: string,
			options: {
				removeSpaces: boolean;
				removePunctuation: boolean;
				unifyKana: boolean;
				toLowerCase: boolean;
			}
		): { normalized: string; indexMap: number[] } {
			const indexMap: number[] = [];
			const punctuationRegex = /[。、！？「」『』（）｛｝［］【】〈〉《》・…ー，．：；‐‑‒–—―−.,!?"'’‘“”(){}[\]<>:;_-]/;
			const whitespaceRegex = /[\s\u3000]/;
			const formatCharRegex = /\p{Cf}/u;

			let normalized = '';
			for (let i = 0; i < text.length; i++) {
				const originalChar = text[i];
				if (!originalChar) {
					continue;
				}

				const nfkc = originalChar.normalize('NFKC');
				for (const rawChar of nfkc) {
					let char = rawChar;
					if (!char) {
						continue;
					}

					if (formatCharRegex.test(char)) {
						continue;
					}

					if (options.toLowerCase) {
						char = char.toLowerCase();
					}

					if (options.removePunctuation && punctuationRegex.test(char)) {
						continue;
					}

					if (options.removeSpaces && whitespaceRegex.test(char)) {
						continue;
					}

					if (options.unifyKana) {
						const charCode = char.charCodeAt(0);
						if (charCode >= 0x30A1 && charCode <= 0x30F6) {
							char = String.fromCharCode(charCode - 0x60);
						}
					}

					normalized += char;
					indexMap.push(i);
				}
			}

			return { normalized, indexMap };
		}

		private advancePastSkippableChars(
			text: string,
			startIndex: number,
			options: {
				removeSpaces: boolean;
				removePunctuation: boolean;
			}
		): number {
			const punctuationRegex = /[。、！？「」『』（）｛｝［］【】〈〉《》・…ー，．：；‐‑‒–—―−.,!?"'’‘“”(){}[\]<>:;_-]/;
			const whitespaceRegex = /[\s\u3000]/;
			const formatCharRegex = /\p{Cf}/u;

			let index = startIndex;
			while (index < text.length) {
				const char = text[index];
				if (!char) {
					index++;
					continue;
				}

				if (formatCharRegex.test(char)) {
					index++;
					continue;
				}

				if (options.removeSpaces && whitespaceRegex.test(char)) {
					index++;
					continue;
				}

			if (options.removePunctuation && punctuationRegex.test(char)) {
				index++;
				continue;
			}

			break;
		}

		return index;
	}

	private findLongestCommonSubstringWithConstraints(
		text1: string,
		text2: string,
		constraints: {
			minLength: number;
			maxStartInText2: number;
			minEndInText1: number;
		}
	): { length: number; positionInText1: number; positionInText2: number } | null {
		if (text1.length === 0 || text2.length === 0) {
			return null;
		}

		// Dynamic programming approach (O(n*m)) to find the longest common substring
		// that satisfies the constraints (helps avoid picking a long but irrelevant match).
		const dp = new Array<number>(text2.length + 1).fill(0);
		let bestLength = 0;
		let bestEndPosInText1 = 0;
		let bestEndPosInText2 = 0;

		for (let i = 1; i <= text1.length; i++) {
			let prevDiagonal = 0;
			for (let j = 1; j <= text2.length; j++) {
				const temp = dp[j] ?? 0;
				if (text1[i - 1] === text2[j - 1]) {
					const newValue = prevDiagonal + 1;
					dp[j] = newValue;

					if (newValue >= constraints.minLength) {
						const startInText2 = j - newValue;
						const endsNearText1Tail = i >= constraints.minEndInText1;
						const startsNearText2Head = startInText2 <= constraints.maxStartInText2;

						if (endsNearText1Tail && startsNearText2Head) {
							const isBetter =
								newValue > bestLength ||
								(newValue === bestLength && i > bestEndPosInText1) ||
								(newValue === bestLength && i === bestEndPosInText1 && j > bestEndPosInText2);

							if (isBetter) {
								bestLength = newValue;
								bestEndPosInText1 = i;
								bestEndPosInText2 = j;
							}
						}
					}
				} else {
					dp[j] = 0;
				}
				prevDiagonal = temp;
			}
		}

		if (bestLength < constraints.minLength) {
			return null;
		}

		return {
			length: bestLength,
			positionInText1: bestEndPosInText1 - bestLength,
			positionInText2: bestEndPosInText2 - bestLength
		};
	}

	/**
	 * Remove duplicate segments based on timestamp overlap
	 */
	private deduplicateSegments(segments: TranscriptionSegment[]): TranscriptionSegment[] {
		if (segments.length === 0) {
			return [];
		}

		const firstSegment = segments[0];
		if (!firstSegment) {
			return [];
		}
		const merged: TranscriptionSegment[] = [firstSegment];
		// Get duplicate window from config or model-specific config
		const duplicateWindowSeconds = this.mergingConfig.duplicateWindowSeconds ?? 30;
		const overlapThreshold = this.mergingConfig.overlapThreshold ?? 0.5;

		for (let i = 1; i < segments.length; i++) {
			const current = segments[i];
			const previous = merged[merged.length - 1];
			if (!current || !previous) {
				continue;
			}

			const currText = current.text.trim();
			const prevText = previous.text.trim();

			// Skip consecutive duplicate text within a short time window
			if (
				currText === prevText &&
				current.start - previous.start <= duplicateWindowSeconds
			) {
				continue;
			}

			// Check for overlap
			if (current.start < previous.end) {
				// Overlapping segments - merge or skip
				if (current.end > previous.end) {
					// Partial overlap - extract non-overlapping part
					const overlapRatio = (previous.end - current.start) / (current.end - current.start);
					if (overlapRatio < overlapThreshold) {
						// Less than threshold overlap, keep both
						merged.push(current);
					} else {
						// Significant overlap, extend previous segment
						previous.end = current.end;
						previous.text += ' ' + current.text;
					}
				}
				// Else: current is completely contained, skip it
			} else {
				// No overlap
				merged.push(current);
			}
		}

		return merged;
	}

	/**
	 * Format failed chunk information
	 */
	private formatFailures(failures: TranscriptionResult[]): string {
		if (failures.length === 0) {
			return '';
		}

		const header = failures.length === 1
			? '**処理に失敗したチャンク:**'
			: `**処理に失敗した${failures.length}個のチャンク:**`;

		const details = failures.map(f =>
			`- チャンク ${f.id} (${this.formatTime(f.startTime)} - ${this.formatTime(f.endTime)}): ${f.error ?? 'Unknown error'}`
		).join('\n');

		return `${header}\n${details}`;
	}

	/**
	 * Format time in MM:SS format
	 */
	private formatTime(seconds: number): string {
		const mins = Math.floor(seconds / 60);
		const secs = Math.floor(seconds % 60);
		return `${mins}:${secs.toString().padStart(2, '0')}`;
	}

	/**
	 * Detect and remove all duplicates in the merged text
	 * This handles cases where the same text appears multiple times,
	 * regardless of chunk boundaries
	 */
	private detectAndRemoveAllDuplicates(text: string, minDuplicateLength: number = 150): string {
		// Get duplicate removal settings from config
		const duplicateRemovalConfig = this.mergingConfig.duplicateRemoval;
		if (!duplicateRemovalConfig?.enabled) {
			return text;
		}

		const duplicateSimilarity = duplicateRemovalConfig.duplicateSimilarityThreshold || 0.9;
		const useFuzzyMatching = duplicateRemovalConfig.useFuzzyMatching !== false;
		let processedText = text;

		// Track processed regions to avoid finding overlapping duplicates
		const processedRegions: Array<{start: number, end: number}> = [];

		// Use sliding window to detect duplicates
		const windowSize = minDuplicateLength; // Use exact minimum length for precision

		// Collect all duplicates first, then remove them in reverse order
		const duplicatesToRemove: Array<{start: number, end: number}> = [];

		// Early exit for texts shorter than 2x minimum duplicate length
		if (processedText.length < minDuplicateLength * 2) {
			return text;
		}

		// Build n-gram index for fast searching if using fuzzy matching
		const nGramSize = getOptimalNGramSize(minDuplicateLength, 'duplicate');
		const nGramIndex = useFuzzyMatching ? buildNGramIndex(processedText, nGramSize, 0) : null;


		// Only search within a reasonable range for performance
		const searchRange = 1000; // Search within 1000 characters as suggested

		for (let i = 0; i < processedText.length - windowSize; i++) {
			// Skip if this position is already part of a found duplicate
			if (processedRegions.some(r => i >= r.start && i < r.end)) {
				continue;
			}

			const candidateText = processedText.slice(i, i + windowSize);

			// Use n-gram index to find potential matches within search range
			const searchStartPos = Math.max(i - searchRange, i + windowSize);
			const searchEndPos = Math.min(i + searchRange, processedText.length);

			let potentialMatches = useFuzzyMatching && nGramIndex ?
				findPotentialMatches(candidateText, nGramIndex, nGramSize, searchStartPos) :
				[{ position: searchStartPos, endPosition: searchEndPos, score: 0 }];

			// Filter matches to stay within search range
			potentialMatches = potentialMatches.filter(m =>
				m.position >= searchStartPos && m.position <= searchEndPos
			);

			// If fuzzy matching found no matches, fall back to checking within range
			if (potentialMatches.length === 0) {
				potentialMatches = [{ position: searchStartPos, endPosition: searchEndPos, score: 0 }];
			}


			for (const match of potentialMatches) {
				let searchStart = match.position;
				const searchEnd = Math.min(match.endPosition, processedText.length);

				while (searchStart <= searchEnd - windowSize) {
					// Skip if this search position overlaps with a found duplicate
					if (processedRegions.some(r => searchStart >= r.start && searchStart < r.end)) {
						const nextRegion = processedRegions.find(r => searchStart >= r.start && searchStart < r.end);
						searchStart = nextRegion ? nextRegion.end : searchStart + 1;
						continue;
					}

					const compareText = processedText.slice(searchStart, searchStart + windowSize);
					let similarity: number;

					if (useFuzzyMatching) {
						// Use normalized n-gram similarity for better speech recognition handling
						similarity = calculateNormalizedNGramSimilarity(
							candidateText,
							compareText,
							nGramSize,
							{
								removeSpaces: true,
								removePunctuation: true,
								unifyKana: true, // Helps match drift between hiragana/katakana across chunks
								toLowerCase: true
							}
						);
					} else {
						// Exact match only
						similarity = candidateText === compareText ? 1.0 : 0.0;
					}


					if (similarity >= duplicateSimilarity) {
						// Found a potential duplicate, try to extend it
						let matchEnd = searchStart + windowSize;

						// Extend while characters match
						while (matchEnd < processedText.length &&
						       i + (matchEnd - searchStart) < processedText.length &&
						       processedText[i + (matchEnd - searchStart)] === processedText[matchEnd]) {
							matchEnd++;
						}

						const fullMatchLength = matchEnd - searchStart;

						if (fullMatchLength >= minDuplicateLength) {
							// Verify the full match still has high similarity
							const fullOrigText = processedText.slice(i, i + fullMatchLength);
							const fullDupText = processedText.slice(searchStart, matchEnd);
							let fullSimilarity: number;

							if (useFuzzyMatching) {
								// Re-calculate with normalized n-gram similarity for the full text
								fullSimilarity = calculateNormalizedNGramSimilarity(
									fullOrigText,
									fullDupText,
									nGramSize,
									{
										removeSpaces: true,
										removePunctuation: true,
										unifyKana: true,
										toLowerCase: true
									}
								);
							} else {
								fullSimilarity = fullOrigText === fullDupText ? 1.0 : 0.0;
							}

							if (fullSimilarity >= duplicateSimilarity) {


								// Add to removal list
								duplicatesToRemove.push({
									start: searchStart,
									end: matchEnd
								});

								// Mark this region as processed
								processedRegions.push({ start: searchStart, end: matchEnd });

								// Skip this entire matched region
								searchStart = matchEnd;
								continue;
							}
						}
					}

					searchStart++;
				}
			}

			// Skip ahead if we found a match starting at position i
			if (processedRegions.some(r => r.start === i)) {
				i += windowSize - 1;
			}
		}

		// Remove duplicates in reverse order to maintain correct positions
		if (duplicatesToRemove.length > 0) {
			// Sort by start position descending
			duplicatesToRemove.sort((a, b) => b.start - a.start);

			let totalRemoved = 0;
			for (const range of duplicatesToRemove) {
				processedText = processedText.slice(0, range.start) + processedText.slice(range.end);
				totalRemoved += range.end - range.start;
			}
			this.logger.info('Removed duplicate text segments', {
				segmentsRemoved: duplicatesToRemove.length,
				totalCharacters: totalRemoved
			});
		} else {
			this.logger.debug('No duplicates detected during merge');
		}

		return processedText;
	}


	/**
	 * Merge with timestamps included in the output text
	 */
	mergeWithTimestampsFormatted(
		results: TranscriptionResult[],
		options: Partial<MergeOptions> = {}
	): string {
		const opts = { ...this.defaultOptions, ...options };
		const validResults = results.filter(r => r.success && r.segments);

		if (validResults.length === 0) {
			return this.simpleMerge(results, opts.separator);
		}

		// Collect all segments
		const allSegments: TranscriptionSegment[] = [];
		for (const result of validResults) {
			if (result.segments) {
				allSegments.push(...result.segments);
			}
		}

		// Sort by start time
		allSegments.sort((a, b) => a.start - b.start);

		// Remove overlapping segments
		const mergedSegments = this.deduplicateSegments(allSegments);

		// Format segments with timestamps
		const formattedSegments = mergedSegments.map(segment => {
			const startTime = this.formatTime(segment.start);
			const endTime = this.formatTime(segment.end);
			const sanitizedText = segment.text
				.replace(/\r\n/g, '\n')
				.replace(/\r/g, '\n')
				.replace(/\s+/g, ' ')
				.trim();
			return `[${startTime} → ${endTime}] ${sanitizedText}`;
		});

		// Join with line breaks (one timestamp per line)
		let output = formattedSegments.join('\n');

		// Apply duplicate removal to the formatted output if enabled
		// Note: For GPT-4o, this is disabled as overlap removal is handled during merge
		if (this.mergingConfig.duplicateRemoval?.enabled) {
			const minLength = this.mergingConfig.duplicateRemoval.minDuplicateLength || 150;


			// Apply duplicate removal to the formatted text
			// This will remove duplicate segments including their timestamps
			output = this.detectAndRemoveAllDuplicates(output, minLength);
		}

		// Add failure information if requested
		const failedResults = results.filter(r => !r.success);
		if (opts.includeFailures && failedResults.length > 0) {
			output += '\n\n---\n' + this.formatFailures(failedResults);
		}

		return output.trim();
	}
}
