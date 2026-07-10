import { FileSystemAdapter, TFile } from 'obsidian';

import { AUDIO_CONSTANTS } from '../../config/constants';
import { Logger } from '../../utils/Logger';
import { PathUtils } from '../../utils/PathUtils';
import { VADError } from '../VadTypes';

import type { FvadModule, FvadWasmInstance } from '../../types/global';
import type { VADProcessor, VADResult, VADConfig, SpeechSegment } from '../VadTypes';
import type { App } from 'obsidian';

/**
 * WebRTC VADプロセッサー
 * Google WebRTCプロジェクトのVADアルゴリズムを使用した高精度な音声検出
 */
export class WebRTCVADProcessor implements VADProcessor {
	protected fvadModule: FvadWasmInstance | null = null;
	protected vadInstance: number | null = null;
	protected available = false;
	protected bufferPtr: number | null = null;
	protected frameSize = AUDIO_CONSTANTS.VAD_FRAME_SIZE; // 30ms @ 16kHz (WebRTC VAD technical requirement)
	protected pluginDir: string;
	protected logger = Logger.getLogger('WebRTCVADProcessor');

	constructor(
    private app: App,
    private config: VADConfig,
    pluginId?: string
	) {
		this.pluginDir = PathUtils.getPluginDir(app, pluginId);
	}

	async initialize(): Promise<void> {

		try {
			// 1. fvad-wasmモジュールをインポート
			const fvadModule = await import('@echogarden/fvad-wasm') as unknown as FvadModule;

			// 2. WASMファイルを読み込む
			const wasmBuffer = await this.loadWasmFile();

			// 3. モジュールを初期化
			// wasmBinaryを直接提供することで、内部のURL解決を回避
			try {

				// モジュールの初期化オプション
				const moduleOptions = {
					wasmBinary: new Uint8Array(wasmBuffer),
					locateFile: (_filename: string) => {
						// この関数は呼ばれないはず（wasmBinaryを直接提供しているため）
						return '';
					},
					// import.meta.urlの問題を回避
					instantiateWasm: async (
						imports: WebAssembly.Imports,
						successCallback: (instance: WebAssembly.Instance) => void
					): Promise<WebAssembly.Instance> => {
						try {
							const result = await WebAssembly.instantiate(new Uint8Array(wasmBuffer), imports);
							successCallback(result.instance);
							return result.instance;
						} catch (error) {
							this.logger.error('WASM instantiation error', error);
							throw error;
						}
					}
				};

				this.fvadModule = await fvadModule.default(moduleOptions);
			} catch (moduleError) {
				this.logger.error('Module initialization error', moduleError);
				throw moduleError;
			}

			// 4. VADインスタンスを作成
			this.vadInstance = this.fvadModule._fvad_new();
			if (!this.vadInstance) {
				throw new Error('Failed to create VAD instance');
			}

			// 5. サンプルレートを設定（16kHz固定）
			const sampleRateResult = this.fvadModule._fvad_set_sample_rate(this.vadInstance, AUDIO_CONSTANTS.SAMPLE_RATE);
			if (sampleRateResult !== 0) {
				throw new Error('Failed to set sample rate');
			}

			// 6. 感度モードを設定（0-3、デフォルトは2）
			const mode = this.getVADMode();
			const modeResult = this.fvadModule._fvad_set_mode(this.vadInstance, mode);
			if (modeResult !== 0) {
				throw new Error(`Failed to set VAD mode: ${mode}`);
			}

			// 7. 処理用バッファを事前確保（メモリ効率化）
			this.bufferPtr = this.fvadModule._malloc(this.frameSize * 2); // 2 bytes per sample
			if (!this.bufferPtr) {
				throw new Error('Failed to allocate buffer');
			}

			this.available = true;
		} catch (error) {
			this.logger.error('Initialization failed', error);
			await this.cleanup();
			throw error;
		}
	}

	/**
   * VAD感度モードを設定から取得
   * 0: Quality (最も緩い)
   * 1: Low bitrate
   * 2: Aggressive (推奨)
   * 3: Very aggressive (最も厳しい)
   */
	private getVADMode(): number {
		const sensitivity = this.config.sensitivity;

		// 0.0-1.0 の感度を 0-3 のモードにマッピング
		if (sensitivity <= 0.25) {
			return 0;
		}
		if (sensitivity <= 0.5) {
			return 1;
		}
		if (sensitivity <= 0.75) {
			return 2;
		}
		return 3;
	}

	/**
   * WASMファイルを読み込む
   */
	private async loadWasmFile(): Promise<ArrayBuffer> {
		const vault = this.app.vault;
		if (!(vault.adapter instanceof FileSystemAdapter)) {
			throw new Error('WebRTC VAD requires FileSystemAdapter (desktop version)');
		}

			// WASMファイルのパスを構築
			try {
				const wasmPaths = PathUtils.getWasmFilePathsFromDir(
					this.pluginDir,
					'fvad.wasm',
					this.app
				);

				// ファイルの存在確認（優先順位順）
				for (const path of wasmPaths) {
					const abstract = vault.getAbstractFileByPath(path);
					if (abstract instanceof TFile) {
						this.logger.debug('WASM file found at:', path);
						return await vault.readBinary(abstract);
					}

					// Fallback: adapter read (avoids exists() / absolute-path checks)
					try {
						const normalizedPath = PathUtils.normalizeUserPath(path);
						const wasmBuffer = await vault.adapter.readBinary(normalizedPath);
						this.logger.debug('WASM file read via adapter at:', normalizedPath);
						return wasmBuffer;
					} catch {
						// continue searching
					}
				}

				// No candidates succeeded
				throw new Error(`WASM file not found in any of the expected locations: ${wasmPaths.join(', ')}`);
			} catch (error: unknown) {
				this.logger.error('Failed to load WASM file', error);
				const errorMessage = this.formatUnknownError(error);
				throw new Error(`Failed to load WASM file: ${errorMessage}`);
		}
	}

	processAudio(audioData: Float32Array, sampleRate: number): Promise<VADResult> {
		if (!this.available || !this.vadInstance || !this.bufferPtr) {
			throw new VADError('VAD not initialized', 'NOT_INITIALIZED');
		}

		const startTime = performance.now();

		try {
			// 1. リサンプリング（必要な場合）
			let processData = audioData;
			if (sampleRate !== AUDIO_CONSTANTS.SAMPLE_RATE) {
				processData = this.resampleTo16kHz(audioData, sampleRate);
			}

			// 2. Float32 → Int16 変換
			const int16Data = this.convertFloat32ToInt16(processData);

			// 3. VADで音声セグメントを検出
			const segments = this.detectVoiceSegments(int16Data);

			// 4. セグメントの後処理（短い無音の結合、パディング追加など）
			const processedSegments = this.postProcessSegments(segments);

			// 5. 音声部分を抽出
			const processedAudio = this.extractSpeechSegments(audioData, processedSegments, sampleRate);

			// 6. 結果を生成
			const result = this.createResult(
				audioData,
				processedAudio,
				processedSegments,
				sampleRate,
				performance.now() - startTime
			);


			return Promise.resolve(result);
		} catch (error: unknown) {
			this.logger.error('Processing error', error);
			const errorMessage = this.formatUnknownError(error);
			throw new VADError(`VAD processing failed: ${errorMessage}`, 'PROCESSING_ERROR');
		}
	}

	/**
   * 16kHzにリサンプリング
   */
	protected resampleTo16kHz(audioData: Float32Array, sourceSampleRate: number): Float32Array {
		const targetSampleRate = AUDIO_CONSTANTS.SAMPLE_RATE;
		const ratio = targetSampleRate / sourceSampleRate;
		const targetLength = Math.floor(audioData.length * ratio);
		const resampled = new Float32Array(targetLength);

		// シンプルな線形補間によるリサンプリング
		for (let i = 0; i < targetLength; i++) {
			const sourceIndex = i / ratio;
			const index = Math.floor(sourceIndex);
			const fraction = sourceIndex - index;

			const current = audioData[index] ?? 0;
			const next = audioData[index + 1] ?? current;
			resampled[i] = current * (1 - fraction) + next * fraction;
		}

		return resampled;
	}

	/**
   * Float32Array を Int16Array に変換
   */
		protected convertFloat32ToInt16(float32Data: Float32Array): Int16Array {
			const int16Data = new Int16Array(float32Data.length);

			for (let i = 0; i < float32Data.length; i++) {
				// クリッピング: -1.0 〜 1.0 の範囲に制限
				const sample = Math.max(-1, Math.min(1, float32Data[i] ?? 0));

				// -32768 〜 32767 にスケーリング
				int16Data[i] = sample < 0 ? sample * 32768 : sample * 32767;
			}

		return int16Data;
	}

	/**
   * 音声セグメントを検出
   */
	private detectVoiceSegments(int16Data: Int16Array): SpeechSegment[] {
		const fvadModule = this.fvadModule;
		const vadInstance = this.vadInstance;
		const bufferPtr = this.bufferPtr;
		if (!this.available || !fvadModule || !vadInstance || bufferPtr === null) {
			throw new VADError('VAD not initialized', 'NOT_INITIALIZED');
		}

		const segments: SpeechSegment[] = [];
		let currentSegment: SpeechSegment | null = null;

		// 30msフレームごとに処理
		const totalFrames = Math.floor(int16Data.length / this.frameSize);

		for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
			const offset = frameIndex * this.frameSize;

			// フレームデータをWASMメモリにコピー
			const frame = int16Data.subarray(offset, offset + this.frameSize);
			fvadModule.HEAP16.set(frame, bufferPtr >> 1);

			// VAD処理
			const isSpeech = fvadModule._fvad_process(
				vadInstance,
				bufferPtr,
				this.frameSize
			);

			// エラーチェック
			if (isSpeech < 0) {
				this.logger.warn('Frame processing error', { frameIndex });
				continue;
			}

			// 時間計算（秒）
			const frameTime = offset / AUDIO_CONSTANTS.SAMPLE_RATE;
			const frameDuration = this.frameSize / AUDIO_CONSTANTS.SAMPLE_RATE; // Frame duration based on sample rate

			if (isSpeech === 1) {
				// 音声検出
				if (!currentSegment) {
					// 新しいセグメント開始
					currentSegment = {
						start: frameTime,
						end: frameTime + frameDuration
					};
				} else {
					// 既存セグメントを延長
					currentSegment.end = frameTime + frameDuration;
				}
			} else {
				// 無音検出
				if (currentSegment) {
					// セグメント終了
					segments.push(currentSegment);
					currentSegment = null;
				}
			}
		}

		// 最後のセグメントを追加
		if (currentSegment) {
			segments.push(currentSegment);
		}

		return segments;
	}

	/**
   * セグメントの後処理
   */
	protected postProcessSegments(segments: SpeechSegment[]): SpeechSegment[] {
		if (segments.length === 0) {
			return segments;
		}

		const processed: SpeechSegment[] = [];
		const minSilenceDuration = this.config.maxSilenceDuration;
		const speechPadding = this.config.speechPadding;

		for (let i = 0; i < segments.length; i++) {
			const baseSegment = segments[i];
			if (!baseSegment) {
				continue;
			}
			const segment = { ...baseSegment };

			// 次のセグメントとの間隔をチェック
			while (i < segments.length - 1) {
				const nextSegment = segments[i + 1];
				if (!nextSegment) {
					break;
				}
				const silenceDuration = nextSegment.start - segment.end;

				// 短い無音で分離されたセグメントを結合
				if (silenceDuration < minSilenceDuration) {
					segment.end = nextSegment.end;
					i++; // 次のセグメントをスキップ
				} else {
					break;
				}
			}

			// パディングを追加（音声の前後に少し余裕を持たせる）
			// 結合されたセグメントに対しては、最初と最後にのみパディングを追加
			segment.start = Math.max(0, segment.start - speechPadding);
			segment.end += speechPadding;

			// 最小セグメント長のチェック
			const duration = segment.end - segment.start;
			if (duration >= this.config.minSpeechDuration) {
				processed.push(segment);
			}
		}

		return processed;
	}

	/**
   * 音声セグメントを抽出
   */
	protected extractSpeechSegments(
		originalAudio: Float32Array,
		segments: SpeechSegment[],
		sampleRate: number
	): Float32Array {
		if (segments.length === 0) {
			return new Float32Array(0);
		}

		// 各セグメントのサンプル数を計算
		let totalSamples = 0;
		const segmentRanges: Array<{ start: number; end: number }> = [];

		for (const segment of segments) {
			const startSample = Math.floor(segment.start * sampleRate);
			const endSample = Math.min(
				originalAudio.length,
				Math.ceil(segment.end * sampleRate)
			);

			if (startSample < endSample) {
				segmentRanges.push({ start: startSample, end: endSample });
				totalSamples += endSample - startSample;
			}
		}

		// 結果配列を作成
		const result = new Float32Array(totalSamples);
		let offset = 0;

		for (const range of segmentRanges) {
			const segmentData = originalAudio.slice(range.start, range.end);
			result.set(segmentData, offset);
			offset += segmentData.length;
		}

		return result;
	}

	/**
   * VAD処理結果を生成
   */
	protected createResult(
		originalAudio: Float32Array,
		processedAudio: Float32Array,
		segments: SpeechSegment[],
		sampleRate: number,
		processingTimeMs: number
	): VADResult {
		const originalDuration = originalAudio.length / sampleRate;
		const processedDuration = processedAudio.length / sampleRate;
		const speechRatio = originalDuration > 0 ? processedDuration / originalDuration : 0;

		// セグメントの平均継続時間を計算
		let totalSegmentDuration = 0;
		for (const segment of segments) {
			totalSegmentDuration += segment.end - segment.start;
		}
		const averageSegmentDuration = segments.length > 0
			? totalSegmentDuration / segments.length
			: 0;

		return {
			processedAudio,
			originalDuration,
			processedDuration,
			segments,
			statistics: {
				speechRatio,
				silenceRatio: 1 - speechRatio,
				totalSegments: segments.length,
				averageSegmentDuration,
				processingTimeMs,
				compressionRatio: 1 - (processedAudio.length / originalAudio.length)
			}
		};
	}

	private formatUnknownError(error: unknown): string {
		if (error instanceof Error) {
			return error.message;
		}
		if (typeof error === 'string') {
			return error;
			}
			try {
				const serialized: unknown = JSON.stringify(error);
				if (typeof serialized === 'string') {
					return serialized;
				}
				return 'Unknown error';
			} catch {
				return 'Unknown error';
			}
		}

	isAvailable(): boolean {
		return this.available;
	}

	cleanup(): Promise<void> {

		// メモリバッファの解放
		if (this.fvadModule && this.bufferPtr) {
			try {
				this.fvadModule._free(this.bufferPtr);
			} catch (error) {
				this.logger.warn('Error freeing buffer', error);
			}
			this.bufferPtr = null;
		}

		// VADインスタンスの解放
		if (this.fvadModule && this.vadInstance) {
			try {
				this.fvadModule._fvad_free(this.vadInstance);
			} catch (error) {
				this.logger.warn('Error freeing VAD instance', error);
			}
			this.vadInstance = null;
		}

		// モジュールの参照を解放
		this.fvadModule = null;
		this.available = false;

		return Promise.resolve();
	}
}
