/**
 * Main transcription controller
 * Entry point for the refactored transcription system
 */

import { Notice } from 'obsidian';

import { AUDIO_CONSTANTS } from '../config/constants';
import { getModelConfig, getTranscriptionConfig, logAllModelConfigs } from '../config/ModelProcessingConfig';
import { AudioPipeline } from '../core/audio/AudioPipeline';
import { ResourceManager } from '../core/resources/ResourceManager';
import { DictionaryCorrector } from '../core/transcription/DictionaryCorrector';
import { SimpleProgressCalculator } from '../core/utils/SimpleProgressCalculator';
import { t } from '../i18n';
import { GPTDictionaryCorrectionService } from '../infrastructure/api/dictionary/GPTDictionaryCorrectionService';
import { FallbackEngine } from '../infrastructure/audio/FallbackEngine';
import { VADChunkingService } from '../infrastructure/audio/VADChunkingService';
import { WebAudioChunkingService } from '../infrastructure/audio/WebAudioChunkingService';
import { WebAudioEngine } from '../infrastructure/audio/WebAudioEngine';
import { SafeStorageService } from '../infrastructure/storage/SafeStorageService';
import { SecurityUtils } from '../infrastructure/storage/SecurityUtils';
import { Logger } from '../utils/Logger';
import { PathUtils } from '../utils/PathUtils';
import { VADPreprocessor } from '../vad/VadPreprocessor';

import { GPT4oTranscriptionService } from './services/GPT4oTranscriptionService';
import { WhisperTranscriptionService } from './services/WhisperTranscriptionService';
import { GPT4oTranscriptionStrategy } from './strategies/GPT4oTranscriptionStrategy';
import { WhisperTranscriptionStrategy } from './strategies/WhisperTranscriptionStrategy';
import { TranscriptionWorkflow } from './workflows/TranscriptionWorkflow';

import type { APITranscriptionSettings, ContextualCorrection, DictionaryEntry, UserDictionary, VADMode } from '../ApiSettings';
import type { AudioProcessingConfig } from '../core/audio/AudioTypes';
import type { ChunkingService } from '../core/chunking/ChunkingService';
import type { ChunkingConfig } from '../core/chunking/ChunkingTypes';
import type { DictionaryEntry as CorrectionDictionaryEntry } from '../core/transcription/DictionaryCorrector';
import type { TranscriptionService } from '../core/transcription/TranscriptionService';
import type { TranscriptionStrategy } from '../core/transcription/TranscriptionStrategy';
import type { TranscriptionProgress } from '../core/transcription/TranscriptionTypes';
import type { ProgressTracker } from '../ui/ProgressTracker';
import type { WorkflowOptions, WorkflowResult } from './workflows/TranscriptionWorkflow';
import type { App, TFile } from 'obsidian';

export class TranscriptionController {
	private app: App;
	private settings: APITranscriptionSettings;
	private progressTracker: ProgressTracker | null;
	private vadPreprocessor: VADPreprocessor | null = null;
	private logger = Logger.getLogger('TranscriptionController');
	private serverSideVADFallback = false;

	// Cached instances
	private audioPipeline: AudioPipeline | null = null;
	private progressCalculator?: SimpleProgressCalculator;

	constructor(
		app: App,
		settings: APITranscriptionSettings,
		progressTracker?: ProgressTracker
	) {
		this.app = app;
		this.settings = settings;
		this.progressTracker = progressTracker ?? null;
	}

	/**
	 * Main transcription entry point
	 */
	async transcribe(
		audioFile: TFile,
		startTime?: number,
		endTime?: number,
		abortSignal?: AbortSignal
	): Promise<string | { text: string; modelUsed: string }> {
		this.logger.info('Starting transcription', {
			file: audioFile.name,
			model: this.settings.model,
			startTime,
			endTime
		});

		const processStartTime = performance.now();
		const timings: Record<string, number> = {};

		try {
			// Load audio file
			const loadStart = performance.now();
			let audioBuffer = await this.app.vault.readBinary(audioFile);
			timings['fileLoad'] = performance.now() - loadStart;
			this.logger.debug('Audio file loaded', {
				size: `${(audioBuffer.byteLength / 1024 / 1024).toFixed(2)}MB`,
				loadTime: `${timings['fileLoad'].toFixed(0)}ms`
			});

			// Initialize components
			await this.initialize();

			// Apply VAD preprocessing (always enabled)
			let vadApplied = false;
				if (this.vadPreprocessor) {
					try {
						const vadStart = performance.now();
						// const originalSize = audioBuffer.byteLength; // Removed: unused variable
						// VADPreprocessor.processFile returns ArrayBuffer (processed audio)
						const processedBuffer = await this.vadPreprocessor.processFile(audioFile, startTime, endTime);
						timings['vadProcessing'] = performance.now() - vadStart;

						// If VAD processing was successful and modified the audio
						// Compare byteLength instead of object reference to avoid
						// false positives when the buffer is re-read from disk
						if (
							processedBuffer.byteLength !== audioBuffer.byteLength
						) {
							audioBuffer = processedBuffer;
							vadApplied = true;
						// Note: Detailed statistics are logged inside VADPreprocessor
					} else {
						// VAD processing didn't modify the audio, use original
					}
				} catch (error) {
					this.logger.error('VAD preprocessing failed', error);

					// ユーザーに通知
					new Notice(
						t('notices.vadProcessingError', { error: error instanceof Error ? error.message : t('errors.general') }),
						5000
					);

					// エラーを再スロー
					throw error;
				}
			} else {
				// VAD not available, use original audio
			}

			// Prepare workflow options
			// If VAD was applied, don't apply time range again (already applied in VAD)
			const effectiveStartTime = vadApplied ? undefined : startTime;
			const effectiveEndTime = vadApplied ? undefined : endTime;
			const options = this.prepareWorkflowOptions(effectiveStartTime, effectiveEndTime, abortSignal);

			// Create workflow
			const { workflow, dictionaryCorrector } = this.createWorkflow();

			// Validate
			const validation = await workflow.validate(audioFile, audioBuffer);
			if (!validation.valid) {
				const errorDetails = Array.isArray(validation.errors) ? validation.errors.join(', ') : '';
				throw new Error(t('errors.validationFailed', { details: errorDetails }));
			}

			// Show warnings if any
			if (validation.warnings && validation.warnings.length > 0) {
				validation.warnings.forEach(warning => {
					this.logger.warn(`Validation warning: ${warning}`);
				});
			}

			// Execute transcription
			this.logger.debug('Executing transcription workflow...');
			const transcriptionStart = performance.now();
			const result = await workflow.execute(audioFile, audioBuffer, options);
			timings['transcription'] = performance.now() - transcriptionStart;
			this.logger.debug('Transcription completed', {
				duration: `${timings['transcription'].toFixed(0)}ms`,
				chunks: result.chunks,
				partial: result.partial
			});

			// Log statistics
			this.logStatistics(audioFile, result);

			// Log timing information
			timings['total'] = performance.now() - processStartTime;

			// Check if result is partial
			if (result.partial) {
				this.logger.warn('Partial transcription result', { error: result.error });
				// Throw an error with the partial results for APITranscriber to handle
				if (result.text) {
					throw new Error(result.text);
				}
			}

			// Apply dictionary correction if enabled
			const correctedText = await this.applyDictionaryCorrection(result.text, dictionaryCorrector);

			// Return both text and model used if available
			if (result.modelUsed) {
				return { text: correctedText, modelUsed: result.modelUsed };
			}
			return correctedText;

		} catch (error) {
			const partialMarker = t('modal.transcription.partialResult');

			// Partial results are expected on cancel/partial failure; avoid logging as ERROR
			if (error instanceof Error && error.message.includes(partialMarker)) {
				this.logger.warn('Transcription returned a partial result');
				throw error;
			}

			// Cancellation is also user-driven; keep logs quieter
			const isCancelled =
				(abortSignal?.aborted ?? false) ||
				(error instanceof DOMException && error.name === 'AbortError') ||
				(error instanceof Error && error.message === t('errors.transcriptionCancelledByUser'));
			if (isCancelled) {
				this.logger.info('Transcription cancelled');
				throw error;
			}

			this.logger.error('Transcription failed', error);
			throw error;
		} finally {
			this.logger.debug('Cleaning up resources...');
			await this.cleanup();
		}
	}

	/**
	 * Initialize components
	 */
	private async initialize(): Promise<void> {
		this.logger.debug('Initializing components...');

		// Log all model configurations for debugging
		if (this.settings.debugMode) {
			logAllModelConfigs();
		}

		// Initialize progress calculator
		this.progressCalculator = new SimpleProgressCalculator(this.settings.postProcessingEnabled);

		// Report preparation progress
		if (this.progressTracker) {
			const currentTask = this.progressTracker.getCurrentTask();
			if (currentTask) {
				const prepProgress = this.progressCalculator.preparationProgress();
				this.progressTracker.updateProgress(currentTask.id, 0, t('modal.transcription.preparingAudio'), prepProgress);
			}
		}

		const vadMode = this.getVadMode();
		this.logger.debug('VAD mode selected', { vadMode });
		if (vadMode === 'local') {
			const vadConfig = getTranscriptionConfig().vad;
			this.vadPreprocessor = new VADPreprocessor(this.app, {
				enabled: true,
				processor: 'auto',
				sensitivity: vadConfig.sensitivity,
				minSpeechDuration: vadConfig.minSpeechDuration,
				maxSilenceDuration: vadConfig.maxSilenceDuration,
				speechPadding: vadConfig.speechPadding,
				debug: this.settings.debugMode
			});
			await this.vadPreprocessor.initialize();
			this.serverSideVADFallback = this.vadPreprocessor.getFallbackMode() === 'server_vad';
			this.logger.debug('VAD preprocessor initialized', {
				serverSideFallback: this.serverSideVADFallback
			});
			if (this.serverSideVADFallback) {
				this.logger.warn('Local VAD unavailable; server-side VAD will be used for chunking.');
			}
		} else {
				this.vadPreprocessor = null;
				this.serverSideVADFallback = true;
			if (vadMode === 'server') {
				this.logger.info('Server-side VAD mode active. Local fvad.wasm will not be used.');
			} else {
				this.logger.info('VAD disabled via settings. Proceeding without silence removal.');
			}
		}

		// Initialize audio pipeline
		if (!this.audioPipeline) {
			this.logger.debug('Creating audio pipeline...');
			this.audioPipeline = this.createAudioPipeline();
		}
	}

	/**
	 * Create audio pipeline
	 */
	private createAudioPipeline(): AudioPipeline {
		// Audio processing config
		const audioConfig: AudioProcessingConfig = {
			targetSampleRate: AUDIO_CONSTANTS.SAMPLE_RATE,
			targetBitDepth: AUDIO_CONSTANTS.BIT_DEPTH,
			targetChannels: AUDIO_CONSTANTS.CHANNELS,
			enableVAD: !this.serverSideVADFallback,
			vadConfig: {
				processor: 'auto',
				sensitivity: 0.7,
				minSpeechDuration: 0.3,
				maxSilenceDuration: 0.5
			}
		};

		// Create audio processor
		let audioProcessor;
		if (WebAudioEngine.isAvailable()) {
			audioProcessor = new WebAudioEngine(audioConfig);
		} else {
			this.logger.warn('WebAudio not available, using fallback audio engine');
			audioProcessor = new FallbackEngine(audioConfig);
		}

		// Create VAD-based chunking service
		const chunkingConfig = this.getChunkingConfig();
		const vadConfig = {
			enabled: !this.serverSideVADFallback,
			processor: 'webrtc' as const,
			sensitivity: 0.7,
			minSpeechDuration: 0.3,
			maxSilenceDuration: 0.5,
			speechPadding: 0.1,
			debug: false
		};

		let chunkingService: ChunkingService;
		if (this.serverSideVADFallback) {
			this.logger.warn('Creating WebAudio chunking service because local VAD is unavailable');
			const fallbackChunkingService = new WebAudioChunkingService(chunkingConfig);
			fallbackChunkingService.setPreferredChunkDuration(
				chunkingConfig.constraints.chunkDurationSeconds
			);
			chunkingService = fallbackChunkingService;
		} else {
			chunkingService = new VADChunkingService(
				this.app,
				chunkingConfig,
				vadConfig,
				PathUtils.getCurrentPluginId()
			);
		}

		// Create pipeline
		const pipeline = new AudioPipeline({
			audioProcessor,
			chunkingService,
			audioConfig
		});

		this.logger.debug('Audio pipeline created', {
			engine: WebAudioEngine.isAvailable() ? 'WebAudio' : 'Fallback'
		});

		return pipeline;
	}

	/**
	 * Get chunking configuration based on model
	 */
	private getChunkingConfig(): ChunkingConfig {
		const model = this.settings.model as string; // Cast to string
		const modelConfig = getModelConfig(model);
		const isWhisper = model.startsWith('whisper-1');


		const serverFallback = this.serverSideVADFallback;

		const minMatchLength = modelConfig.merging.minMatchLength ?? 0;

		return {
			constraints: {
				maxSizeMB: modelConfig.maxFileSizeMB,
				maxDurationSeconds: modelConfig.maxDurationSeconds,
				chunkDurationSeconds: modelConfig.chunkDurationSeconds,
				recommendedOverlapSeconds: modelConfig.vadChunking.overlapDurationSeconds,
				supportsParallelProcessing: modelConfig.maxConcurrentChunks > 1,
				maxConcurrentChunks: modelConfig.maxConcurrentChunks
			},
			modelName: model, // Pass model name for VAD chunking config
			processingMode: isWhisper ? 'parallel' : 'sequential',
			useServerVAD: serverFallback,
				mergeStrategy: isWhisper ? {
					type: 'overlap_removal',
					config: {
						minMatchLength
					}
				} : {
					type: 'simple',
					config: {
						separator: '\n\n'
					}
				},
			optimizeBoundaries: modelConfig.vadChunking.optimizeBoundaries
		};
	}

	/**
	 * Create workflow based on model
	 */
	private createWorkflow(): { workflow: TranscriptionWorkflow; dictionaryCorrector: DictionaryCorrector } {
		this.logger.debug('Creating transcription workflow', { model: this.settings.model });

		// Get API key
		const apiKey = this.getApiKey();

		// Create dictionary corrector with user dictionary
		const dictionaryCorrector = this.createDictionaryCorrector(apiKey);

		// Create service and strategy
		let service: TranscriptionService;
		let strategy: TranscriptionStrategy;

		const model = this.settings.model as string; // Cast to string

		if (model.startsWith('whisper-1')) {
			this.logger.debug('Using Whisper transcription service', { model });
			service = new WhisperTranscriptionService(apiKey, model, dictionaryCorrector);
			strategy = new WhisperTranscriptionStrategy(
				service,
				this.createProgressAdapter()
			);
		} else {
			// GPT-4o or GPT-4o Mini
			let gpt4oModel: string;

			if (model === 'gpt-4o-transcribe') {
				gpt4oModel = 'gpt-4o-transcribe';
			} else {
				gpt4oModel = 'gpt-4o-mini-transcribe';
			}

				this.logger.debug('Using GPT-4o transcription service', { model: gpt4oModel });
				service = new GPT4oTranscriptionService(apiKey, gpt4oModel, dictionaryCorrector);
				strategy = new GPT4oTranscriptionStrategy(
					service,
					this.createProgressAdapter()
				);
			}

			if (this.settings.debugMode) {
				service.enableCleaningDebugMode();
			}

			// Create workflow
				const pipeline = this.audioPipeline ?? this.createAudioPipeline();
				this.audioPipeline = pipeline;
				const workflow = new TranscriptionWorkflow(pipeline, strategy);
				this.logger.debug('Workflow created successfully');
				return { workflow, dictionaryCorrector };
			}

	/**
	 * Apply dictionary correction to transcribed text
	 */
	private async applyDictionaryCorrection(text: string, corrector: DictionaryCorrector): Promise<string> {
		// Only apply if dictionary correction is enabled
		if (!this.settings.dictionaryCorrectionEnabled) {
			this.logger.trace('Dictionary correction disabled, skipping');
			return text;
		}

			this.logger.debug('Applying dictionary corrections...');
			try {
				const currentLanguage = this.settings.language || 'auto';
				const correctedText = await corrector.correct(text, currentLanguage);

			if (correctedText !== text) {
				this.logger.debug('Dictionary corrections applied');
			}

			return correctedText;
		} catch (error) {
			this.logger.error('Dictionary correction failed', error);
			// Return original text on error
				return text;
			}
		}

	/**
	 * Create dictionary corrector with user dictionary
	 */
			private createDictionaryCorrector(apiKey: string): DictionaryCorrector {
			// Get API key for GPT correction
			// Enable GPT correction if post-processing is enabled
			const useGPTCorrection = this.settings.postProcessingEnabled;
			const resourceManager = ResourceManager.getInstance();
			const gptService = useGPTCorrection
				? new GPTDictionaryCorrectionService(apiKey, resourceManager)
				: undefined;

			const corrector = new DictionaryCorrector(useGPTCorrection, gptService);

			if (!this.settings.dictionaryCorrectionEnabled) {
				return corrector;
			}

		// Get current language setting
			const currentLanguage = this.settings.language;

		if (currentLanguage === 'auto') {
			// For auto-detect, use all language dictionaries combined
			const allEntries = this.convertAllDictionariesToEntries();

			if (allEntries.length > 0) {
				const multiDict = {
					name: 'user-dictionary-multi',
					language: 'multi', // Special language code for multi-language
					enabled: true,
					useGPTCorrection: useGPTCorrection,
					// Pass all dictionaries data for GPT correction
					definiteCorrections: [
						...this.settings.userDictionaries.ja.definiteCorrections,
						...this.settings.userDictionaries.en.definiteCorrections,
						...this.settings.userDictionaries.zh.definiteCorrections
					],
						contextualCorrections: [
							...(this.settings.userDictionaries.ja.contextualCorrections ?? []),
							...(this.settings.userDictionaries.en.contextualCorrections ?? []),
							...(this.settings.userDictionaries.zh.contextualCorrections ?? [])
						],
						entries: allEntries
					};
				corrector.addDictionary(multiDict);
			}
		} else if (currentLanguage === 'ja' || currentLanguage === 'en' || currentLanguage === 'zh') {
			// For specific language, use only that language's dictionary
				const userDictionary = this.settings.userDictionaries[currentLanguage];
				const entries = this.convertDictionaryToEntries(userDictionary);

				if (entries.length > 0) {
					const langDict = {
						name: `user-dictionary-${currentLanguage}`,
						language: currentLanguage,
						enabled: true,
						useGPTCorrection: useGPTCorrection,
						definiteCorrections: userDictionary.definiteCorrections,
						contextualCorrections: userDictionary.contextualCorrections ?? [],
						entries: entries
					};
					corrector.addDictionary(langDict);
				}
			}

		return corrector;
	}

	/**
	 * Convert a single user dictionary to entries
	 */
	private convertDictionaryToEntries(userDictionary: UserDictionary): CorrectionDictionaryEntry[] {
		const entries: CorrectionDictionaryEntry[] = [];

			// Add definite corrections as rules
			entries.push(
				...userDictionary.definiteCorrections
					.filter((entry: DictionaryEntry) => entry.from.length > 0 && entry.to)
					.flatMap((entry: DictionaryEntry) => {
						return entry.from.map((pattern: string) => {
							const mapped: CorrectionDictionaryEntry = {
								pattern,
							replacement: entry.to,
							caseSensitive: false
						};
						if (entry.category !== undefined) {
							mapped.category = entry.category;
						}
						if (entry.priority !== undefined) {
							mapped.priority = entry.priority;
						}
						return mapped;
					});
				})
		);

			// Add contextual corrections as rules with conditions
			entries.push(
				...(userDictionary.contextualCorrections ?? [])
					.filter((entry: ContextualCorrection) => entry.from.length > 0 && entry.to)
					.flatMap((entry: ContextualCorrection) => {
						return entry.from.map((pattern: string) => {
							const mapped: CorrectionDictionaryEntry = {
								pattern,
							replacement: entry.to,
							caseSensitive: false
						};
						if (entry.category !== undefined) {
							mapped.category = entry.category;
						}
						if (entry.priority !== undefined) {
							mapped.priority = entry.priority;
						}
						if (entry.contextKeywords && entry.contextKeywords.length > 0) {
							const keywords = entry.contextKeywords;
							mapped.condition = (text: string) => keywords.some((keyword: string) => text.includes(keyword));
						}
						return mapped;
					});
				})
		);

		return entries;
	}

	/**
	 * Convert all language dictionaries to entries
	 */
	private convertAllDictionariesToEntries(): CorrectionDictionaryEntry[] {
		const allEntries: CorrectionDictionaryEntry[] = [];
		const languages: ('ja' | 'en' | 'zh' | 'ko')[] = ['ja', 'en', 'zh', 'ko'];

			for (const lang of languages) {
				const dict = this.settings.userDictionaries[lang];
				allEntries.push(...this.convertDictionaryToEntries(dict));
			}

		return allEntries;
	}

	/**
	 * Get decrypted API key
	 */
	private getApiKey(): string {
		const storedKey = this.settings.openaiApiKey;

		// Use SafeStorageService to retrieve the actual API key
		const apiKey = SafeStorageService.decryptFromStore(storedKey);

		// Validate API key format using SecurityUtils
			const validation = SecurityUtils.validateOpenAIAPIKey(apiKey);
			if (!validation.valid) {
				throw new Error(validation.error ?? 'Invalid API key');
			}

		return apiKey;
	}

	/**
	 * Create progress adapter that converts TranscriptionProgress to ProgressTracker format
	 */
	private createProgressAdapter(): (progress: TranscriptionProgress) => void {
		if (!this.progressTracker || !this.progressCalculator) {
			return () => {
				// Progress tracking is disabled; no-op
			};
		}

		// We need to get the current task ID from the API transcriber
		// Since the controller doesn't have direct access to it, we'll create a closure
		// that captures the current task ID when it's called
		return (progress: TranscriptionProgress) => {
			try {
				// Get the current task from the progress tracker
				const currentTask = this.progressTracker?.getCurrentTask();
				if (!currentTask) {
					// This can happen if the task was already completed or cancelled
					// Just log the progress without updating the tracker
					return;
				}

				// Convert TranscriptionProgress to ProgressTracker format
				const completedChunks = progress.currentChunk;
				const message = progress.operation;

				// Update the total chunks if it's different from what we initially set
				if (progress.totalChunks !== currentTask.totalChunks) {
					// Update the task with correct total chunks via ProgressTracker
					this.progressTracker?.updateTotalChunks(currentTask.id, progress.totalChunks);
					// Also update progress calculator
					this.progressCalculator?.updateTotalChunks(progress.totalChunks);
				}

				// Calculate unified progress using SimpleProgressCalculator
				const unifiedPercentage = this.progressCalculator?.transcriptionProgress(completedChunks) ?? 0;

				// Call the actual updateProgress method with the correct parameters
				this.progressTracker?.updateProgress(currentTask.id, completedChunks, message, unifiedPercentage);

			} catch (error) {
				// Don't let progress tracking errors break the transcription
				this.logger.error('Error in progress adapter (continuing)', error);
			}
		};
	}

	/**
	 * Prepare workflow options
	 */
		private prepareWorkflowOptions(
			startTime?: number,
			endTime?: number,
			abortSignal?: AbortSignal
			): WorkflowOptions {
				const options: WorkflowOptions = {
					language: this.settings.language
					// Note: VAD is already applied at the file level before this point
				};
			if (startTime !== undefined) {
				options.startTime = startTime;
			}
			if (endTime !== undefined) {
				options.endTime = endTime;
			}
			if (abortSignal) {
				options.signal = abortSignal;
			}
			return options;
		}


	/**
	 * Log statistics
	 */
	private logStatistics(file: TFile, result: WorkflowResult): void {
		this.logger.info('Transcription completed', {
			file: file.name,
			model: this.settings.model,
			duration: `${result.duration.toFixed(1)}s`,
			chunks: result.chunks,
			chunkStrategy: result.strategy.needsChunking
				? `${result.strategy.totalChunks} chunks (${result.strategy.chunkDuration}s each)`
				: 'Single chunk',
			textLength: result.text.length,
				charsPerSecond: (result.text.length / result.duration).toFixed(2),
				partial: result.partial ?? false
			});
		}

	/**
	 * Cleanup resources
	 */
	private async cleanup(): Promise<void> {
		// Clean up VAD preprocessor
		if (this.vadPreprocessor) {
			await this.vadPreprocessor.cleanup();
			this.vadPreprocessor = null;
		}

		// Clean up audio pipeline (which includes WebAudioEngine and VADChunkingService)
		if (this.audioPipeline) {
			try {
				// AudioPipeline should cleanup its audio processor (WebAudioEngine)
				const audioProcessor = (this.audioPipeline as unknown as { audioProcessor?: { cleanup?: () => Promise<void> } }).audioProcessor;
				if (audioProcessor && typeof audioProcessor.cleanup === 'function') {
					await audioProcessor.cleanup();
				}

				// Clean up chunking service (VADChunkingService)
				const chunkingService = (this.audioPipeline as unknown as { chunkingService?: { cleanup?: () => Promise<void> } }).chunkingService;
				if (chunkingService && typeof chunkingService.cleanup === 'function') {
					await chunkingService.cleanup();
				}
			} catch (error) {
				this.logger.error('Error cleaning up audio pipeline', error);
			}
			this.audioPipeline = null;
		}
	}

	/**
	 * Test API connection
	 */
	async testConnection(): Promise<boolean> {
		this.logger.debug('Testing API connection...');
		const startTime = performance.now();

		try {
			const apiKey = this.getApiKey(); // This already validates format
			// Use SecurityUtils for API connection test
			const result = await SecurityUtils.testOpenAIAPIKey(apiKey);

			const elapsedTime = performance.now() - startTime;
			this.logger.info('Connection test completed', {
				valid: result.valid,
				elapsedTime: `${elapsedTime.toFixed(2)}ms`
			});

			return result.valid;
		} catch (error) {
			this.logger.error('Connection test failed', error);
			return false;
		}
	}

	/**
	 * Update settings
	 */
	updateSettings(settings: APITranscriptionSettings): void {
		this.logger.debug('Updating transcription controller settings', {
			model: settings.model,
			language: settings.language,
			postProcessingEnabled: settings.postProcessingEnabled
		});
		this.settings = settings;
		// Clear cached instances to force recreation with new settings
		this.audioPipeline = null;
	}

		private getVadMode(): VADMode {
			return this.settings.vadMode;
		}

}
