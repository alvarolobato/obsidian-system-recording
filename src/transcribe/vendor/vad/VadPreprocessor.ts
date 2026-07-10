import { Notice } from 'obsidian';

import { getTranscriptionConfig } from '../config/ModelProcessingConfig';
import { t } from '../i18n';
import { Logger } from '../utils/Logger';

import { WebRTCVADProcessor } from './processors/WebrtcVadProcessor';
import { AudioConverter } from './utils/AudioConverter';

import type {
	VADConfig,
	VADProcessor,
	VADResult
} from './VadTypes';
import type { App, TFile } from 'obsidian';

/**
 * VADプリプロセッサー
 * 音声ファイルから無音を除去するメインクラス
 */
export class VADPreprocessor {
	private processor: VADProcessor | null = null;
	private config: VADConfig;
	private audioConverter: AudioConverter;
	private logger: Logger;
	private fallbackMode: 'none' | 'server_vad' = 'none';
	private initialized = false;

	// メモリキャッシュ（ファイルの重複読み込みを避ける）
	private audioBufferCache = new Map<string, ArrayBuffer>();
	private cacheMaxSize = 5; // 最大5ファイルをキャッシュ

	constructor(
		private app: App,
		config: Partial<VADConfig> = {}
	) {
		// model-processing.configからデフォルト設定を取得
		const defaultConfig = getTranscriptionConfig().vad;
		const baseConfig: VADConfig = {
			enabled: false,
			processor: 'auto',
			sensitivity: defaultConfig.sensitivity,
			minSpeechDuration: defaultConfig.minSpeechDuration,
			maxSilenceDuration: defaultConfig.maxSilenceDuration,
			speechPadding: defaultConfig.speechPadding,
			debug: false
		};

		this.config = { ...baseConfig, ...config };
		this.audioConverter = new AudioConverter();
		this.logger = Logger.getLogger('VADPreprocessor');
		this.logger.debug('VADPreprocessor initialized', {
			enabled: this.config.enabled,
			processor: this.config.processor,
			sensitivity: this.config.sensitivity,
			minSpeechDuration: this.config.minSpeechDuration,
			maxSilenceDuration: this.config.maxSilenceDuration
		});
	}

	/**
   * Get the current VAD processor instance
   */
	getProcessor(): VADProcessor | null {
		return this.processor;
	}

	getFallbackMode(): 'none' | 'server_vad' {
		return this.fallbackMode;
	}
	private isServerFallback(): boolean {
		return this.fallbackMode === 'server_vad';
	}

	/**
   * VADプリプロセッサーを初期化
   */
	async initialize(): Promise<void> {
		if (this.initialized && (this.processor !== null || this.fallbackMode === 'server_vad')) {
			this.logger.debug('VAD preprocessor already initialized', {
				fallbackMode: this.fallbackMode
			});
			return;
		}

		this.logger.debug('Initializing VAD preprocessor');

		this.fallbackMode = 'none';

		try {
			// プロセッサーの選択と初期化
			this.processor = await this.createProcessor();

			if (this.processor) {
				this.logger.info('VAD processor initialized successfully', {
					processorType: this.processor.constructor.name
				});
			} else if (this.isServerFallback()) {
				this.logger.warn('Local VAD unavailable. Falling back to server-side VAD.');
				new Notice(t('notices.vadServerFallback'), 5000);
				this.config.enabled = false;
			} else {
				if (this.config.enabled) {
					this.logger.error('VAD is enabled but processor is null');
					throw new Error(t('notices.vadInitError'));
				}
				this.logger.debug('VAD is disabled, skipping processor initialization');
			}
		} catch (error) {
			this.logger.error('Failed to initialize VAD preprocessor', error);
			if (!this.isServerFallback()) {
				this.processor = null;

				// VADが有効なのに初期化に失敗した場合は、エラーを再スロー
				if (this.config.enabled) {
					throw error;
				}
			}
		} finally {
			this.initialized = true;
		}
	}

	/**
   * 音声ファイルを処理して無音を除去
   * @param audioFile - 処理する音声ファイル
   * @param startTime - 開始時間（秒）、nullの場合は全体
   * @param endTime - 終了時間（秒）、nullの場合は全体
   */
	async processFile(audioFile: TFile, rangeStart?: number | null, rangeEnd?: number | null): Promise<ArrayBuffer> {
		const processingStartTime = performance.now();
		this.logger.debug('Processing audio file with VAD', {
			fileName: audioFile.name,
			rangeStart,
			rangeEnd,
			enabled: this.config.enabled,
			fallbackMode: this.fallbackMode
		});

		let audioBuffer: ArrayBuffer | null = null;

		try {
			// キャッシュからファイルを読み込み（重複読み込みを避ける）
			audioBuffer = await this.getCachedAudioBuffer(audioFile);

				let useServerFallback = this.isServerFallback();

				// プロセッサーが未初期化の場合、初期化を試みる
				if (this.config.enabled && this.getProcessor() === null && !useServerFallback) {
					await this.initialize();
					useServerFallback = this.isServerFallback();

					// 初期化が失敗した場合は、エラーをスロー
					const processorAfterInit = this.getProcessor();
					if (processorAfterInit === null && !useServerFallback) {
						this.logger.error('Failed to initialize VAD processor');
						throw new Error(t('notices.vadInitError'));
					}
				}

			// オーディオデータをデコード
			this.logger.debug('Decoding audio file');
			const { audioData, sampleRate } = await this.audioConverter.decodeAudioFile(
				audioBuffer,
				audioFile.extension
			);
			this.logger.debug('Audio decoded', {
				sampleRate,
				duration: `${(audioData.length / sampleRate).toFixed(2)}s`,
				samples: audioData.length
			});

			// 時間範囲が指定されている場合は、効率的に処理
			let processedAudioData = audioData;
			let actualRangeStart = 0;
			let actualRangeEnd = audioData.length / sampleRate;
			let rangeApplied = false;

				if (rangeStart !== null && rangeStart !== undefined || rangeEnd !== null && rangeEnd !== undefined) {
					const totalDuration = audioData.length / sampleRate;
					actualRangeStart = rangeStart ?? 0;
					actualRangeEnd = rangeEnd ?? totalDuration;

				// 範囲をサンプル数に変換
				const startSample = Math.floor(actualRangeStart * sampleRate);
				const endSample = Math.min(audioData.length, Math.floor(actualRangeEnd * sampleRate));

				// subarrayを使用して効率的に抽出
				processedAudioData = audioData.subarray(startSample, endSample);
				rangeApplied = endSample - startSample !== audioData.length;
			}

			// ローカルVADが利用可能な場合はそのまま実行
			if (this.processor) {
				this.logger.debug('Starting VAD processing', {
					audioLength: processedAudioData.length,
					duration: `${(processedAudioData.length / sampleRate).toFixed(2)}s`
				});

				const result = await this.processor.processAudio(processedAudioData, sampleRate);

				// 統計情報をログ（範囲情報を含む）
				this.logStatistics(result, performance.now() - processingStartTime, actualRangeStart, actualRangeEnd);

				// 処理された音声をWAVにエンコード
				this.logger.debug('Encoding processed audio to WAV');
				const processedWav = await this.audioConverter.encodeToWAV(
					result.processedAudio,
					sampleRate
				);

				const totalTime = performance.now() - processingStartTime;
				this.logger.info('VAD processing completed', {
					originalDuration: `${(audioData.length / sampleRate).toFixed(2)}s`,
					processedDuration: `${(result.processedAudio.length / sampleRate).toFixed(2)}s`,
					totalTime: `${totalTime.toFixed(2)}ms`,
					speechSegments: result.segments.length
				});

				return processedWav;
			}

			// ローカルVADが利用できない場合のフォールバック処理
			this.logger.info('Local VAD unavailable, using fallback audio path', {
				useServerFallback,
				rangeApplied
			});

			// 範囲が適用されている場合は結果をWAVにエンコードして返す
			if (rangeApplied) {
				this.logger.debug('Encoding trimmed audio to WAV for fallback path');
				return await this.audioConverter.encodeToWAV(processedAudioData, sampleRate);
			}

			// それ以外の場合は元のバッファを返す
			return audioBuffer;
		} catch (error) {
			this.logger.error('Error processing file with VAD', error);

			// VADが有効化されているのにエラーが発生した場合は、エラーを再スロー
			if (this.config.enabled && this.fallbackMode !== 'server_vad') {
				throw new Error(t('notices.vadProcessingError', { error: error instanceof Error ? error.message : 'Unknown error' }));
			}

			// フォールバック時は元のバッファを返す
			return audioBuffer ?? new ArrayBuffer(0);
		}
	}

	/**
   * 設定を更新
   */
	updateConfig(config: Partial<VADConfig>): void {
		this.config = { ...this.config, ...config };
		this.logger.debug('VAD config updated', {
			changed: Object.keys(config),
			newConfig: this.config
		});
	}

	/**
   * クリーンアップ
   */
	async cleanup(): Promise<void> {
		if (this.processor) {
			await this.processor.cleanup();
			this.processor = null;
		}
		this.initialized = false;
		this.fallbackMode = 'none';

		// キャッシュをクリア
		this.audioBufferCache.clear();

		// AudioConverterのクリーンアップ
		this.audioConverter.cleanup();
	}

	/**
   * プロセッサーを作成
   */
		private async createProcessor(): Promise<VADProcessor | null> {
			const { processor } = this.config;

			// WebRTC VADを最優先（高精度、軽量、実績あり）
			try {
				const webrtcProcessor = new WebRTCVADProcessor(this.app, this.config);
				await webrtcProcessor.initialize();

				if (webrtcProcessor.isAvailable()) {
					return webrtcProcessor;
				}
			} catch (error) {
				this.logger.warn('Failed to initialize WebRTC VAD', error);

				// Check if the error is related to missing fvad.wasm
				if (error instanceof Error && error.message.includes('WASM file not found')) {
					this.fallbackMode = 'server_vad';
					return null;
				}
			}

		if (this.fallbackMode === 'server_vad') {
			return null;
		}

		// WebRTC VADが失敗した場合のエラー処理
		if (processor === 'auto') {
			this.logger.error('WebRTC VAD unavailable - fvad.wasm required for VAD processing');
			// VADが有効化されているのに初期化できない場合は、nullを返す
			// 呼び出し側でエラーをスローする
			return null;
		}

		// 明示的に指定されたプロセッサーが利用できない場合
		this.logger.error('Requested VAD processor is not available', { processor });
		return null;
	}

	/**
   * キャッシュからオーディオバッファを取得（重複読み込みを避ける）
   */
	private async getCachedAudioBuffer(audioFile: TFile): Promise<ArrayBuffer> {
		const cacheKey = `${audioFile.path}_${audioFile.stat.mtime}`;

		// キャッシュにある場合は返す
		const cached = this.audioBufferCache.get(cacheKey);
		if (cached) {
			this.logger.trace('Audio buffer found in cache', { fileName: audioFile.name });
			return cached;
		}

		// ファイルを読み込み
		this.logger.trace('Reading audio file from vault', { fileName: audioFile.name });
		const audioBuffer = await this.app.vault.readBinary(audioFile);

		// キャッシュサイズ制限のチェック
		if (this.audioBufferCache.size >= this.cacheMaxSize) {
			// 最も古いエントリを削除（FIFO）
			let firstKey: string | undefined;
			for (const key of this.audioBufferCache.keys()) {
				firstKey = key;
				break;
			}
			if (firstKey) {
				this.audioBufferCache.delete(firstKey);
			}
		}

		// キャッシュに追加
		this.audioBufferCache.set(cacheKey, audioBuffer);

		return audioBuffer;
	}

	/**
   * 統計情報をログ
   */
	private logStatistics(result: VADResult, totalTimeMs: number, rangeStart?: number, rangeEnd?: number): void {
		const stats = result.statistics;

		const logData: Record<string, string | number> = {
			totalSegments: stats.totalSegments,
			speechRatio: `${(stats.speechRatio * 100).toFixed(1)}%`,
			processingTime: `${totalTimeMs.toFixed(2)}ms`
		};

		// 範囲情報を表示
		if (rangeStart !== undefined && rangeEnd !== undefined) {
			logData['range'] = `${rangeStart}s - ${rangeEnd}s`;
		}

		this.logger.debug('VAD Statistics', logData);
	}
}
