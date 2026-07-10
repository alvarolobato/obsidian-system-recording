/**
 * Whisper-specific transcription strategy
 * Implements parallel processing with timestamp-based merging
 */

import { getModelConfig } from '../../config/ModelProcessingConfig';
import { TranscriptionMerger } from '../../core/transcription/TranscriptionMerger';
import { TranscriptionStrategy } from '../../core/transcription/TranscriptionStrategy';
import { t } from '../../i18n';
import { Logger } from '../../utils/Logger';

import type { AudioChunk } from '../../core/audio/AudioTypes';
import type { TranscriptionService } from '../../core/transcription/TranscriptionService';
import type { TranscriptionResult, TranscriptionOptions, TranscriptionProgress } from '../../core/transcription/TranscriptionTypes';


export class WhisperTranscriptionStrategy extends TranscriptionStrategy {
	readonly strategyName = 'Whisper Parallel Processing';
	readonly processingMode = 'parallel' as const;
	readonly maxConcurrency = 2; // Process 2 chunks in parallel

	private merger: TranscriptionMerger;
	private rateLimitDelay: number;
	private workflowLanguage: string = 'auto';

	constructor(
		transcriptionService: TranscriptionService,
		onProgress?: (progress: TranscriptionProgress) => void
	) {
		super(transcriptionService, onProgress);
		// Pass model name to merger for model-specific merge config
		this.merger = new TranscriptionMerger(transcriptionService.modelId);
		this.logger = Logger.getLogger('WhisperTranscriptionStrategy');

		// Get rate limit delay from config based on model
		const config = getModelConfig(transcriptionService.modelId);
		this.rateLimitDelay = config.rateLimitDelayMs;
	}

	/**
	 * Process chunks in parallel batches
	 */
	async processChunks(
		chunks: AudioChunk[],
		options: TranscriptionOptions
	): Promise<TranscriptionResult[]> {
		this.workflowLanguage = options.language;

		const results: TranscriptionResult[] = [];
		const startTime = Date.now();

		// Process in batches to respect rate limits
		for (let i = 0; i < chunks.length; i += this.maxConcurrency) {
			try {
				// Check for cancellation
				this.checkAborted();

				const batch = chunks.slice(i, i + this.maxConcurrency);
				const batchNumber = Math.floor(i / this.maxConcurrency) + 1;
				const totalBatches = Math.ceil(chunks.length / this.maxConcurrency);

				// Report batch progress
				this.reportProgress({
					currentChunk: i + 1, // Use 1-based indexing to match GPT4o strategy
					totalChunks: chunks.length,
					percentage: (i / chunks.length) * 90, // Reserve 10% for merging
					operation: `Processing batch ${batchNumber}/${totalBatches} (${batch.length} chunks)`,
					estimatedTimeRemaining: this.calculateTimeRemaining(i, chunks.length, startTime),
					cancellable: true
				});

				// Process batch in parallel
				const batchPromises = batch.map((chunk) => {
					return this.processSingleChunk(chunk, options);
				});

				const batchResults = await Promise.all(batchPromises);
				results.push(...batchResults);

				// Apply rate limiting between batches
				if (i + this.maxConcurrency < chunks.length) {
					await this.delay(this.rateLimitDelay);
				}
			} catch (error) {
				// If cancelled or aborted, return current results
				if (error instanceof Error && (error.message.includes('cancelled') || error.message.includes('aborted'))) {
					break; // Exit the loop but keep the results we have
				}
				// For other errors, log and continue with next batch
				this.logger.error(`Failed to process batch starting at chunk ${i + 1}:`, error);
				// Add failed results for this batch
				const batch = chunks.slice(i, i + this.maxConcurrency);
				const errorMessage = error instanceof Error ? error.message : t('errors.general');
				batch.forEach((chunk, idx) => {
					results.push({
						id: chunk.id,
						text: t('modal.transcription.chunkFailure', { index: (i + idx + 1).toString(), error: errorMessage }),
						startTime: chunk.startTime,
						endTime: chunk.endTime,
						success: false,
						error: errorMessage
					});
				});
			}
		}

		return results;
	}


	/**
	 * Merge results using timestamp-based algorithm
	 */
	async mergeResults(results: TranscriptionResult[]): Promise<string> {
		const { valid, failed } = this.filterResults(results);

		if (valid.length === 0 && failed.length === 0) {
			return '';
		}

		// Log statistics
		if (failed.length > 0) {
			const failedIds = failed.map(chunk => chunk.id).join(', ');
			this.logger.warn(`Whisper merge encountered failed chunks: ${failedIds}`);
		} else {
			this.logger.debug('All Whisper chunks processed successfully before merging');
		}

		// If no valid results but we have failed results, return error information
		if (valid.length === 0) {
			const errorInfo = failed.map(f =>
				t('modal.transcription.chunkFailureSummary', {
					id: f.id.toString(),
					error: f.error || t('errors.general')
				})
			).join('\n');
			const failedChunks = failed.map(f => f.id).join(', ') || failed.length.toString();
			const notice = t('modal.transcription.partialFailedChunks', { chunks: failedChunks });
			return `${notice}\n${errorInfo}`;
		}

		// Use timestamp-based merging if available
		const hasTimestamps = valid.some(r => r.segments && r.segments.length > 0);

		let mergedText: string;
		if (hasTimestamps) {
			// Use formatted merge for whisper-1-ts model to include timestamps in output
			const isTimestampModel = this.transcriptionService.modelId === 'whisper-1-ts';
			if (isTimestampModel) {
				mergedText = this.merger.mergeWithTimestampsFormatted(results, {
					includeFailures: true,
					useTimestamps: true
				});
			} else {
				mergedText = this.merger.mergeWithTimestamps(results, {
					includeFailures: true,
					useTimestamps: true
				});
			}
			} else {
				// Get model-specific merge config
				const modelConfig = getModelConfig(this.transcriptionService.modelId);
				const mergeConfig = modelConfig.merging;

				mergedText = this.merger.mergeWithOverlapRemoval(results, {
					removeOverlaps: true,
					minMatchLength: mergeConfig.minMatchLength ?? 20,
					separator: '\n\n',
					includeFailures: true
				});
			}

		mergedText = await this.postProcessMergedText(mergedText, results, this.workflowLanguage);

		// If we have partial results, prepend a notice
		if (failed.length > 0) {
			const failedChunks = failed.map(f => f.id).join(', ') || failed.length.toString();
			const notice = t('modal.transcription.partialFailedChunks', { chunks: failedChunks });
			return `${notice}\n\n${mergedText}`;
		}

		return mergedText;
	}

	/**
	 * Get optimal settings for Whisper
	 */
	getOptimalSettings(): {
		chunkDuration: number;
		overlapDuration: number;
		responseFormat: string;
		} {
		// Get chunk duration from model configuration instead of hardcoding
		const modelConfig = getModelConfig('whisper-1');

		return {
			chunkDuration: modelConfig.chunkDurationSeconds,
			overlapDuration: modelConfig.vadChunking.overlapDurationSeconds,
			responseFormat: 'verbose_json' // For timestamps
		};
	}

	/**
	 * Estimate processing time for Whisper
	 */
	estimateProcessingTime(chunks: AudioChunk[]): number {
		// Whisper typically processes at ~10-20x realtime speed
		const totalDuration = chunks.reduce((sum, chunk) =>
			sum + (chunk.endTime - chunk.startTime), 0
		);

		const processingSpeed = 15; // 15x realtime (conservative estimate)
		const baseTime = totalDuration / processingSpeed;

		// Add overhead for batching and rate limiting
		const batches = Math.ceil(chunks.length / this.maxConcurrency);
		const rateLimitOverhead = (batches - 1) * (this.rateLimitDelay / 1000);

		return baseTime + rateLimitOverhead;
	}
}
