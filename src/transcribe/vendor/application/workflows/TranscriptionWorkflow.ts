/**
 * Main transcription workflow orchestrator
 * Coordinates the entire transcription process from audio file to final text
 */


import { SUPPORTED_FORMATS, APP_LIMITS } from '../../config/constants';
import { ResourceManager } from '../../core/resources/ResourceManager';
import { t } from '../../i18n';
import { Logger } from '../../utils/Logger';

import type { AudioPipeline } from '../../core/audio/AudioPipeline';
import type { AudioInput, AudioChunk } from '../../core/audio/AudioTypes';
import type { ChunkStrategy } from '../../core/chunking/ChunkingTypes';
import type { TranscriptionStrategy } from '../../core/transcription/TranscriptionStrategy';
import type { TranscriptionOptions } from '../../core/transcription/TranscriptionTypes';
import type { TFile } from 'obsidian';

export interface WorkflowOptions {
	startTime?: number;
	endTime?: number;
	language?: string;
	signal?: AbortSignal;
}

export interface WorkflowResult {
	text: string;
	duration: number;
	chunks: number;
	strategy: ChunkStrategy;
	segments?: Array<{
		text: string;
		start: number;
		end: number;
	}>;
	/** The actual model used for transcription */
	modelUsed?: string;
	/** Whether the result is partial due to cancellation or error */
	partial?: boolean;
	/** Error message if partial */
	error?: string;
}

export class TranscriptionWorkflow {
	private audioPipeline: AudioPipeline;
	private strategy: TranscriptionStrategy;
	private abortController: AbortController | null = null;
	private resourceId: string;
	private resourceManager: ResourceManager;
	private externalSignal: AbortSignal | undefined;
	private logger: Logger;

	constructor(
		audioPipeline: AudioPipeline,
		strategy: TranscriptionStrategy
	) {
		this.audioPipeline = audioPipeline;
		this.strategy = strategy;
		this.resourceId = `workflow-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
		this.resourceManager = ResourceManager.getInstance();
		this.logger = Logger.getLogger('TranscriptionWorkflow');
		this.logger.debug('TranscriptionWorkflow initialized', {
			strategyName: strategy.strategyName,
			processingMode: strategy.processingMode,
			resourceId: this.resourceId
		});
	}

	/**
	 * Execute the complete transcription workflow
	 */
	async execute(
		file: TFile,
		audioBuffer: ArrayBuffer,
		options: WorkflowOptions = {}
	): Promise<WorkflowResult> {
		const startTime = Date.now();
		this.logger.info('Starting transcription workflow', {
			fileName: file.name,
			fileSize: `${(audioBuffer.byteLength / 1024 / 1024).toFixed(2)}MB`,
			language: options.language,
			startTime: options.startTime,
			endTime: options.endTime
		});

		// Create abort controller using ResourceManager
		this.abortController = this.resourceManager.getAbortController(this.resourceId);
		this.externalSignal = options.signal;

		if (options.signal) {
			// Link external abort signal
			const abortHandler = () => {
				this.abortController?.abort();
			};
			options.signal.addEventListener('abort', abortHandler);

			// Register cleanup handler
			this.resourceManager.registerCleanupHandler(this.resourceId, () => {
				if (this.externalSignal) {
					this.externalSignal.removeEventListener('abort', abortHandler);
				}
			});
		}

		let chunks: AudioChunk[] = [];
		let chunkStrategy: ChunkStrategy;

		try {
			// Step 1: Prepare audio input
			this.logger.debug('Step 1: Preparing audio input');
			const audioInput = this.createAudioInput(file, audioBuffer);

			// Step 2: Process audio through pipeline
			this.logger.debug('Step 2: Processing audio through pipeline');
			const processResult = await this.audioPipeline.process(
				audioInput,
				options.startTime,
				options.endTime
			);
			chunks = processResult.chunks;
			chunkStrategy = processResult.strategy;
			this.logger.debug('Audio processing complete', {
				chunkCount: chunks.length,
				strategyType: chunkStrategy.type || 'default',
				needsChunking: chunkStrategy.needsChunking
			});

			// Check for cancellation
			this.checkAborted();

				// Step 3: Prepare transcription options
				this.logger.debug('Step 3: Preparing transcription options');
				const transcriptionOptions = this.prepareTranscriptionOptions(options);

			// Step 4: Execute transcription strategy
			this.logger.debug('Step 4: Executing transcription strategy', {
				strategy: this.strategy.strategyName
			});
			const result = await this.strategy.execute(chunks, transcriptionOptions);

				// Step 5: Calculate final statistics
				const duration = (Date.now() - startTime) / 1000;
				const modelUsed = this.strategy.getModelUsed();
				const workflowResult: WorkflowResult = {
					text: result.text,
					duration,
					chunks: chunks.length,
					strategy: chunkStrategy,
					segments: result.segments ?? []
				};

				workflowResult.modelUsed = modelUsed;
				if (result.partial !== undefined) {
					workflowResult.partial = result.partial;
				}
				if (result.error !== undefined) {
					workflowResult.error = result.error;
				}

			this.logger.info('Transcription workflow completed', {
					duration: `${duration.toFixed(2)}s`,
					textLength: result.text.length,
					chunksProcessed: chunks.length,
					partial: result.partial ?? false,
					modelUsed: workflowResult.modelUsed
				});

			return workflowResult;

		} catch (error) {
			const duration = (Date.now() - startTime) / 1000;
			this.logger.error('Workflow failed', {
				duration: `${duration.toFixed(2)}s`,
				chunksProcessed: chunks.length,
				error
			});

			// Don't try to recover if we have no chunks
			if (chunks.length === 0) {
				if (error instanceof Error && error.message.includes('cancelled')) {
					this.logger.debug('Workflow cancelled by user');
				}
				throw error;
			}

			// If the error came from execute() and includes partial results
			if (error instanceof Error && error.message.includes('[部分的な文字起こし結果]')) {
				// The error message itself contains the partial results
				throw error; // Pass it through
			}

			// Re-throw original error
			if (error instanceof Error && error.message.includes('cancelled')) {
				this.logger.info('Transcription workflow cancelled after processing began');
			}
			throw error;
		} finally {
			this.cleanup();
		}
	}

	/**
	 * Create audio input from file
	 */
	private createAudioInput(file: TFile, audioBuffer: ArrayBuffer): AudioInput {
		return {
			data: audioBuffer,
			fileName: file.name,
			extension: file.extension,
			size: audioBuffer.byteLength
		};
	}

	/**
	 * Prepare transcription options
	 */
	private prepareTranscriptionOptions(options: WorkflowOptions): TranscriptionOptions {
		const transcriptionOptions: TranscriptionOptions = {
			language: options.language || 'auto',
			timestamps: true
		};
		const signal = this.abortController?.signal ?? options.signal;
		if (signal) {
			transcriptionOptions.signal = signal;
		}
		return transcriptionOptions;
	}

	/**
	 * Check if workflow was aborted
	 */
	private checkAborted(): void {
		if (this.abortController?.signal.aborted) {
			throw new Error(t('errors.transcriptionCancelledByUser'));
		}
	}

	/**
	 * Cleanup resources
	 */
	private cleanup(): void {
		// Clean up AbortController and event listeners via ResourceManager
		this.resourceManager.cleanupAbortController(this.resourceId);
		this.abortController = null;
		this.externalSignal = undefined;
	}

	/**
	 * Validate workflow inputs
	 */
	validate(
		file: TFile,
		audioBuffer: ArrayBuffer
	): Promise<{ valid: boolean; errors: string[]; warnings?: string[] }> {
		const errors: string[] = [];
		const warnings: string[] = [];

			// Check file
			// Check audio buffer
			if (audioBuffer.byteLength === 0) {
				errors.push('Empty audio buffer');
			}

		// Check file size for warning
		const sizeMB = audioBuffer.byteLength / (1024 * 1024);
		const warningSizeMB = APP_LIMITS.LARGE_FILE_WARNING_SIZE_MB;
		if (sizeMB > warningSizeMB) {
			warnings.push(`大きなファイル（${sizeMB.toFixed(1)} MB）の処理には時間がかかる場合があります`);
		}

		// Check file extension
		const supportedExtensions = SUPPORTED_FORMATS.EXTENSIONS;
		if (!supportedExtensions.includes(file.extension.toLowerCase())) {
			errors.push(`Unsupported file format: ${file.extension}`);
		}

		return Promise.resolve({
			valid: errors.length === 0,
			errors,
			...(warnings.length > 0 && { warnings })
		});
	}

	/**
	 * Get workflow statistics
	 */
	getStatistics(): {
		modelType: string;
		processingMode: string;
		chunkingEnabled: boolean;
		} {
		return {
			modelType: this.strategy.strategyName,
			processingMode: this.strategy.processingMode,
			chunkingEnabled: true // Always true in new architecture
		};
	}
}
