/**
 * VAD (Voice Activity Detection) 型定義
 */

/**
 * VADプロセッサーのインターフェース
 */
export interface VADProcessor {
  /**
   * VADプロセッサーを初期化
   */
  initialize: () => Promise<void>;

  /**
   * 音声データから無音を除去
   * @param audioData - 入力音声データ (Float32Array)
   * @param sampleRate - サンプリングレート
   * @returns 無音除去された音声データ
   */
  processAudio: (audioData: Float32Array, sampleRate: number) => Promise<VADResult>;

  /**
   * リソースをクリーンアップ
   */
  cleanup: () => Promise<void>;

  /**
   * プロセッサーが利用可能かチェック
   */
  isAvailable: () => boolean;
}

/**
 * VAD処理結果
 */
export interface VADResult {
  /**
   * 処理された音声データ (無音除去済み)
   */
  processedAudio: Float32Array;

  /**
   * 元の音声の長さ（秒）
   */
  originalDuration: number;

  /**
   * 処理後の音声の長さ（秒）
   */
  processedDuration: number;

  /**
   * 検出された音声セグメント
   */
  segments: SpeechSegment[];

  /**
   * 統計情報
   */
  statistics: VADStatistics;
}

/**
 * 音声セグメント
 */
export interface SpeechSegment {
  /**
   * セグメント開始時刻（秒）
   */
  start: number;

  /**
   * セグメント終了時刻（秒）
   */
  end: number;

  /**
   * セグメントの音声データ
   */
  audio?: Float32Array;
}

/**
 * VAD統計情報
 */
export interface VADStatistics {
  /**
   * 総セグメント数
   */
  totalSegments: number;

  /**
   * 音声の割合 (0-1)
   */
  speechRatio: number;

  /**
   * 無音の割合 (0-1)
   */
  silenceRatio: number;

  /**
   * 削減されたデータサイズの割合 (0-1)
   */
  compressionRatio: number;

  /**
   * 処理時間（ミリ秒）
   */
  processingTimeMs: number;

  /**
   * 平均セグメント継続時間（秒）
   */
  averageSegmentDuration?: number;
}

/**
 * VAD設定
 */
export interface VADConfig {
  /**
   * VADを有効にするか
   */
  enabled: boolean;

  /**
   * 使用するVADプロセッサー
   */
  processor: 'webrtc' | 'auto';

  /**
   * 音声検出の感度 (0-1, 高いほど敏感)
   */
  sensitivity: number;

  /**
   * 最小音声セグメント長（秒）
   */
  minSpeechDuration: number;

  /**
   * 最大無音長（秒） - これより短い無音は保持
   */
  maxSilenceDuration: number;

  /**
   * 音声セグメントの前後に追加するパディング（秒）
   */
  speechPadding: number;

  /**
   * デバッグログを出力するか
   */
  debug: boolean;
}

// VAD設定のデフォルト値はmodel-processing.config.tsで管理

/**
 * VADプロセッサーファクトリー関数の型
 */
export type VADProcessorFactory = (config: VADConfig) => Promise<VADProcessor>;

/**
 * VADエラー
 */
export class VADError extends Error {
	constructor(message: string, readonly cause?: unknown) {
		super(message);
		this.name = 'VADError';
	}
}