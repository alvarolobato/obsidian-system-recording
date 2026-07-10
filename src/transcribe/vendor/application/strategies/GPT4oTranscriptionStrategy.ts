/**
 * GPT-4o-specific transcription strategy
 * Implements wave-parallel processing with bounded context preservation
 */

import { getModelConfig } from '../../config/ModelProcessingConfig';
import { ConsecutiveBlockRepeatCleaner, TailRepeatCleaner } from '../../core/transcription/cleaners';
import { TranscriptionMerger } from '../../core/transcription/TranscriptionMerger';
import { TranscriptionStrategy } from '../../core/transcription/TranscriptionStrategy';
import { planWaveConcurrency } from '../../core/utils/WaveConcurrencyPlanner';
import { planWaveGroupSizes } from '../../core/utils/WaveGroupPlanner';
import { t } from '../../i18n';
import { Logger } from '../../utils/Logger';

import type { AudioChunk } from '../../core/audio/AudioTypes';
import type { TranscriptionService } from '../../core/transcription/TranscriptionService';
import type { TranscriptionResult, TranscriptionOptions, TranscriptionProgress } from '../../core/transcription/TranscriptionTypes';

interface AdaptiveWaveState {
	concurrencyLimit: number;
	inFlightGroups: number;
	rateLimitHits: number;
	cooldownUntilMs: number;
}

export class GPT4oTranscriptionStrategy extends TranscriptionStrategy {
	readonly strategyName = 'GPT-4o Wave Parallel Processing';
	readonly processingMode = 'batch' as const;
	readonly maxConcurrency = 4;

	private static readonly WAVE_MIN_GROUP_SIZE = 3;
	private static readonly WAVE_MAX_GROUP_SIZE = 5;
	private static readonly CHUNK_MAX_RETRY = 1;
	private static readonly RATE_LIMIT_BACKOFF_BASE_MS = 2000;
	private static readonly RATE_LIMIT_BACKOFF_MAX_MS = 15000;

	private merger: TranscriptionMerger;
	private workflowLanguage: string = 'auto';
	private readonly continuationBlockRepeatCleaner = new ConsecutiveBlockRepeatCleaner({
		enabled: true,
		minBlockNormalizedChars: 120,
		maxUnitSentences: 20,
		allowSingleSentence: true
	});
	private readonly continuationTailRepeatCleaner = new TailRepeatCleaner({
		enabled: true,
		maxTailParagraphs: 8,
		maxTailSentences: 20,
		minRepeatCount: 3,
		similarityThreshold: 0.9,
		maxUnitParagraphs: 3,
		maxUnitSentences: 5
	});

	constructor(
		transcriptionService: TranscriptionService,
		onProgress?: (progress: TranscriptionProgress) => void
	) {
		super(transcriptionService, onProgress);
		this.merger = new TranscriptionMerger(transcriptionService.modelId);
		this.logger = Logger.getLogger('GPT4oTranscriptionStrategy');

		// Ensure model config is loaded (used by other components and logs)
		getModelConfig(transcriptionService.modelId);
	}

	/**
	 * Process chunks using wave-parallel grouping:
	 * - Within a group: sequential with previousContext
	 * - Across groups: run in parallel up to maxConcurrency
	 */
	async processChunks(
		chunks: AudioChunk[],
		options: TranscriptionOptions
	): Promise<TranscriptionResult[]> {
		this.workflowLanguage = options.language;

		if (chunks.length === 0) {
			return [];
		}

		const results: TranscriptionResult[] = [];
		const startTime = Date.now();
		const totalChunks = chunks.length;

		const groupSizes = planWaveGroupSizes(chunks.length, {
			minGroupSize: GPT4oTranscriptionStrategy.WAVE_MIN_GROUP_SIZE,
			maxGroupSize: GPT4oTranscriptionStrategy.WAVE_MAX_GROUP_SIZE,
			distributeRemainderToEnd: true
		});

		const groups = this.createGroups(chunks, groupSizes);
		const totalGroups = groups.length;
		const totalDurationSeconds = this.getTotalDurationSeconds(chunks);

		const progressState = { completedChunks: 0 };
		let nextGroupIndex = 0;
		const initialConcurrency = planWaveConcurrency(totalDurationSeconds, totalGroups, this.maxConcurrency);
		const adaptiveState: AdaptiveWaveState = {
			concurrencyLimit: initialConcurrency,
			inFlightGroups: 0,
			rateLimitHits: 0,
			cooldownUntilMs: 0
		};

		const runWorker = async (): Promise<void> => {
			for (;;) {
				const acquired = await this.acquireGroupSlot(adaptiveState);
				if (!acquired) {
					return;
				}
				const currentGroupIndex = nextGroupIndex;
				nextGroupIndex++;
				if (currentGroupIndex >= totalGroups) {
					this.releaseGroupSlot(adaptiveState);
					return;
				}
				const group = groups[currentGroupIndex];
				if (!group) {
					this.releaseGroupSlot(adaptiveState);
					continue;
				}
				try {
					await this.processGroup(group, currentGroupIndex, totalGroups, totalChunks, options, startTime, results, progressState, adaptiveState);
				} finally {
					this.releaseGroupSlot(adaptiveState);
				}
			}
		};

		const workers = Array.from({ length: this.maxConcurrency }, () => runWorker());
		await Promise.all(workers);

		return results;
	}

	private async acquireGroupSlot(state: AdaptiveWaveState): Promise<boolean> {
		for (;;) {
			if (this.abortSignal?.aborted) {
				return false;
			}

			const now = Date.now();
			if (state.cooldownUntilMs > now) {
				const waitMs = state.cooldownUntilMs - now;
				try {
					await this.delay(waitMs);
				} catch {
					return false;
				}
				continue;
			}

			if (state.inFlightGroups < state.concurrencyLimit) {
				state.inFlightGroups++;
				return true;
			}

			try {
				await this.delay(50);
			} catch {
				return false;
			}
		}
	}

	private releaseGroupSlot(state: AdaptiveWaveState): void {
		state.inFlightGroups = Math.max(0, state.inFlightGroups - 1);
	}

	private onRateLimitHit(state: AdaptiveWaveState): void {
		state.rateLimitHits++;
		const prevLimit = state.concurrencyLimit;
		state.concurrencyLimit = Math.max(1, state.concurrencyLimit - 1);

		const backoff = Math.min(
			GPT4oTranscriptionStrategy.RATE_LIMIT_BACKOFF_MAX_MS,
			GPT4oTranscriptionStrategy.RATE_LIMIT_BACKOFF_BASE_MS * Math.pow(2, state.rateLimitHits - 1)
		);
		state.cooldownUntilMs = Math.max(state.cooldownUntilMs, Date.now() + backoff);

		if (state.concurrencyLimit !== prevLimit) {
			this.logger.warn('Rate limit detected; reducing wave concurrency', {
				previous: prevLimit,
				next: state.concurrencyLimit,
				cooldownMs: backoff
			});
		} else {
			this.logger.warn('Rate limit detected; applying cooldown', { cooldownMs: backoff });
		}
	}

	private getTotalDurationSeconds(chunks: AudioChunk[]): number {
		let minStart = Infinity;
		let maxEnd = 0;
		for (const chunk of chunks) {
			minStart = Math.min(minStart, chunk.startTime);
			maxEnd = Math.max(maxEnd, chunk.endTime);
		}
		const normalizedMinStart = Number.isFinite(minStart) ? minStart : 0;
		return Math.max(0, maxEnd - normalizedMinStart);
	}

	private createGroups(chunks: AudioChunk[], sizes: number[]): AudioChunk[][] {
		const groups: AudioChunk[][] = [];
		let offset = 0;
		for (const size of sizes) {
			if (size <= 0) {
				continue;
			}
			const group = chunks.slice(offset, offset + size);
			if (group.length > 0) {
				groups.push(group);
			}
			offset += size;
		}
		return groups;
	}

	private async processGroup(
		group: AudioChunk[],
		groupIndex: number,
		totalGroups: number,
		totalChunks: number,
		options: TranscriptionOptions,
		startTime: number,
		results: TranscriptionResult[],
		progressState: { completedChunks: number },
		adaptiveState: AdaptiveWaveState
	): Promise<void> {
		let previousChunkText = '';

		for (let i = 0; i < group.length; i++) {
			if (this.abortSignal?.aborted) {
				return;
			}

			const chunk = group[i];
			if (!chunk) {
				continue;
			}

			// Check chunk size before sending to API
			const chunkSizeMB = chunk.data.byteLength / (1024 * 1024);
			if (chunkSizeMB > 25) {
				const indexLabel = (chunk.id + 1).toString();
				const errorMessage = `Chunk size ${chunkSizeMB.toFixed(1)}MB exceeds API limit of 25MB`;
				results.push({
					id: chunk.id,
					text: t('modal.transcription.chunkFailure', { index: indexLabel, error: errorMessage }),
					startTime: chunk.startTime,
					endTime: chunk.endTime,
					success: false,
					error: errorMessage
				});
				previousChunkText = '';
				progressState.completedChunks++;
				this.reportWaveProgress(progressState.completedChunks, groupIndex, totalGroups, chunk.id, totalChunks, startTime);
				continue;
			}

			// Process chunk with previous context (within the group only)
			let previousContext: string | undefined;
			if (previousChunkText) {
				const maxContextChars = getModelConfig(this.transcriptionService.modelId).contextWindowSize;
				const lastSentences = this.extractLastSentences(previousChunkText, maxContextChars);
				if (lastSentences) {
					previousContext = lastSentences;
				}
			}

			const result = await this.transcribeChunkWithSingleRetry(chunk, options, previousContext, adaptiveState);
			results.push(result);

			if (result.success && result.text) {
				previousChunkText = this.sanitizeContinuationContext(result.text, options.language);
			} else {
				// If a chunk fails, avoid using stale context from earlier chunks.
				// Treat the next chunk as a "new start" so it can recover overlap content.
				previousChunkText = '';
			}

			progressState.completedChunks++;
			this.reportWaveProgress(progressState.completedChunks, groupIndex, totalGroups, chunk.id, totalChunks, startTime);
		}
	}

	private sanitizeContinuationContext(text: string, language: string): string {
		const original = text.trim();
		if (!original) {
			return '';
		}

		// Avoid feeding looped/hallucinated output back into the next chunk.
		const blockResult = this.continuationBlockRepeatCleaner.clean(original, language);
		const tailResult = this.continuationTailRepeatCleaner.clean(blockResult.cleanedText, language);
		const cleaned = tailResult.cleanedText.trim();

		if (!cleaned) {
			return '';
		}

		if (cleaned !== original) {
			const removedChars = original.length - cleaned.length;
			if (removedChars > 0) {
				this.logger.debug('Sanitized continuation context', {
					beforeLength: original.length,
					afterLength: cleaned.length,
					removedChars,
					blockPatterns: blockResult.metadata?.patternsMatched?.length ?? 0,
					tailPatterns: tailResult.metadata?.patternsMatched?.length ?? 0
				});
			}
		}

		return cleaned;
	}

	private async transcribeChunkWithSingleRetry(
		chunk: AudioChunk,
		options: TranscriptionOptions,
		previousContext: string | undefined,
		adaptiveState: AdaptiveWaveState
	): Promise<TranscriptionResult> {
		let attempt = 0;
		let lastResult: TranscriptionResult | null = null;

		while (attempt <= GPT4oTranscriptionStrategy.CHUNK_MAX_RETRY) {
			if (this.abortSignal?.aborted) {
				break;
			}

			const now = Date.now();
			if (adaptiveState.cooldownUntilMs > now) {
				try {
					await this.delay(adaptiveState.cooldownUntilMs - now);
				} catch {
					break;
				}
			}

			if (attempt > 0) {
				this.logger.warn('Retrying GPT-4o chunk transcription', { chunkId: chunk.id, attempt });
			}

			const result = await this.processSingleChunk(chunk, options, previousContext);
			lastResult = result;

			if (result.success) {
				return result;
			}

			const errorKind = this.classifyChunkError(result.error);
			if (errorKind === 'cancelled') {
				return result;
			}

			const shouldRetry = attempt < GPT4oTranscriptionStrategy.CHUNK_MAX_RETRY &&
				(errorKind === 'rate_limit' || errorKind === 'timeout' || errorKind === 'server');
			if (!shouldRetry) {
				return result;
			}

			if (errorKind === 'rate_limit') {
				this.onRateLimitHit(adaptiveState);
			}

			const waitMs = this.getRetryBackoffMs(errorKind, adaptiveState);
			if (waitMs > 0) {
				try {
					await this.delay(waitMs);
				} catch {
					return result;
				}
			}

			attempt++;
		}

		return lastResult ?? {
			id: chunk.id,
			text: '',
			startTime: chunk.startTime,
			endTime: chunk.endTime,
			success: false,
			error: t('errors.general')
		};
	}

	private classifyChunkError(errorMessage: string | undefined): 'rate_limit' | 'timeout' | 'server' | 'cancelled' | 'unknown' {
		if (!errorMessage) {
			return 'unknown';
		}
		const lower = errorMessage.toLowerCase();
		if (lower.includes('cancelled') || lower.includes('aborted') || lower.includes('request cancelled')) {
			return 'cancelled';
		}
		if (lower.includes('api error 429') || /\b429\b/.test(lower) || lower.includes('rate limit')) {
			return 'rate_limit';
		}
		if (lower.includes('api error 408') || lower.includes('timeout') || lower.includes('timed out')) {
			return 'timeout';
		}
		if (/\bapi error 5\d\d\b/.test(lower)) {
			return 'server';
		}
		return 'unknown';
	}

	private getRetryBackoffMs(
		errorKind: 'rate_limit' | 'timeout' | 'server' | 'cancelled' | 'unknown',
		adaptiveState: AdaptiveWaveState
	): number {
		if (errorKind === 'rate_limit') {
			const now = Date.now();
			return Math.max(0, adaptiveState.cooldownUntilMs - now);
		}
		// For single retry, rely on ApiClient's internal backoff; keep additional wait minimal.
		return 0;
	}

	private reportWaveProgress(
		completedChunks: number,
		groupIndex: number,
		totalGroups: number,
		chunkId: number,
		totalChunks: number,
		startTime: number
	): void {
		const clampedCompleted = Math.max(0, Math.min(completedChunks, totalChunks));
		const percentage = (clampedCompleted / totalChunks) * 90; // Reserve 10% for merging
		const groupLabel = `${groupIndex + 1}/${totalGroups}`;
		const chunkLabel = `${chunkId + 1}/${totalChunks}`;

		this.reportProgress({
			currentChunk: clampedCompleted,
			totalChunks,
			percentage,
			operation: `Transcribing chunk ${chunkLabel} (group ${groupLabel})`,
			estimatedTimeRemaining: this.calculateTimeRemaining(Math.max(1, clampedCompleted), totalChunks, startTime),
			cancellable: true
		});
	}

	/**
	 * Extract last sentences from text (within token limit)
	 */
	private extractLastSentences(text: string, maxLength: number): string {
		const sentences: string[] = [];
		let current = '';
		for (const ch of text) {
			current += ch;
			if (ch === '。' || ch === '.' || ch === '!' || ch === '?' || ch === '！' || ch === '？' || ch === '\n') {
				sentences.push(current);
				current = '';
			}
		}
		if (current) {
			sentences.push(current);
		}

		const selectedSentences: string[] = [];
		let totalLength = 0;
		for (let i = sentences.length - 1; i >= 0; i--) {
			const raw = sentences[i];
			if (!raw) {
				continue;
			}
			const sentence = raw.trim();
			if (!sentence) {
				continue;
			}

			const additionalLength = selectedSentences.length > 0 ? sentence.length + 1 : sentence.length;
			if (totalLength + additionalLength <= maxLength) {
				selectedSentences.unshift(sentence);
				totalLength += additionalLength;
			} else {
				break;
			}
		}

		const result = selectedSentences.join(' ');
		return result || text.slice(-maxLength);
	}

	/**
	 * Merge results with simple concatenation (context already handled)
	 */
	async mergeResults(results: TranscriptionResult[]): Promise<string> {
		const { valid, failed } = this.filterResults(results);

		if (valid.length === 0 && failed.length === 0) {
			return '';
		}

		// If no valid results but we have failed results, return error information
		if (valid.length === 0) {
			const pseudo = failed.map(f => this.toFailurePlaceholderResult(f));
			const merged = this.merger.mergeWithOverlapRemoval(pseudo, { separator: '\n\n' });
			const failedChunksLabel = failed.map(f => f.id).join(', ') || failed.length.toString();
			const notice = t('modal.transcription.partialFailedChunks', { chunks: failedChunksLabel });
			return `${notice}\n\n${merged}`;
		}

		// Use overlap removal to handle chunk boundary duplicates.
		// If there are failed chunks, insert placeholders so gaps are visible/recoverable.
		const mergeInputs = failed.length > 0
			? results.map(r => (r.success ? r : this.toFailurePlaceholderResult(r)))
			: valid;
		let mergedText = this.merger.mergeWithOverlapRemoval(mergeInputs, { separator: '\n\n' });

		mergedText = await this.postProcessMergedText(mergedText, results, this.workflowLanguage);

		// If we have partial results, prepend a notice
		if (failed.length > 0) {
			const failedChunks = failed.map(f => f.id).join(', ') || failed.length.toString();
			const notice = t('modal.transcription.partialFailedChunks', { chunks: failedChunks });
			return `${notice}\n\n${mergedText}`;
		}

		return mergedText;
	}

	private toFailurePlaceholderResult(result: TranscriptionResult): TranscriptionResult {
		const startLabel = this.formatSeconds(result.startTime);
		const endLabel = this.formatSeconds(result.endTime);
		const errorMessage = result.error ? result.error : t('errors.general');

		return {
			...result,
			success: true,
			text: `【欠損: チャンク${result.id + 1} (${startLabel}–${endLabel})】\n${errorMessage}`
		};
	}

	private formatSeconds(seconds: number): string {
		const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
		const total = Math.floor(safe);
		const h = Math.floor(total / 3600);
		const m = Math.floor((total % 3600) / 60);
		const s = total % 60;
		const hh = String(h).padStart(2, '0');
		const mm = String(m).padStart(2, '0');
		const ss = String(s).padStart(2, '0');
		return `${hh}:${mm}:${ss}`;
	}

	/**
	 * Get optimal settings for GPT-4o/GPT-4o Mini
	 */
	getOptimalSettings(): {
		chunkDuration: number;
		overlapDuration: number;
		responseFormat: string;
		maxContextLength: number;
	} {
		// Get chunk duration from model configuration instead of hardcoding
		const modelConfig = getModelConfig(this.transcriptionService.modelId);

		return {
			chunkDuration: modelConfig.chunkDurationSeconds,
			overlapDuration: modelConfig.vadChunking.overlapDurationSeconds,
			responseFormat: 'json', // Only JSON supported
			maxContextLength: modelConfig.contextWindowSize
		};
	}

	/**
	 * Estimate processing time for GPT-4o
	 */
	estimateProcessingTime(chunks: AudioChunk[]): number {
		// GPT-4o is slower than Whisper, processes at ~5-10x realtime
		const totalDuration = chunks.reduce((sum, chunk) =>
			sum + (chunk.endTime - chunk.startTime), 0
		);

		const processingSpeed = 7; // 7x realtime (conservative estimate)
		const baseTime = totalDuration / processingSpeed;

		// Add overhead for sequential processing
		const perChunkOverhead = 2; // 2 seconds per chunk
		const totalOverhead = chunks.length * perChunkOverhead;

		return baseTime + totalOverhead;
	}

}
