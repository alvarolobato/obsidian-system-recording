/**
 * Application Constants
 * 統一された定数定義でハードコーディングを排除
 */

/**
 * 音声処理関連の定数
 */
export const AUDIO_CONSTANTS = {
	/** 標準サンプルレート (Hz) */
	SAMPLE_RATE: 16000,
	/** ビット深度 */
	BIT_DEPTH: 16,
	/** チャンネル数 (モノラル) */
	CHANNELS: 1,
	/** VADフレームサイズ (30ms @ 16kHz) */
	VAD_FRAME_SIZE: 480
} as const;

/**
 * サポートされるファイル形式
 */
export const SUPPORTED_FORMATS = {
	/** サポートする音声ファイル拡張子 */
	AUDIO_EXTENSIONS: [
		'mp3', 'm4a', 'wav', 'flac', 'ogg', 'aac'
	] as string[],

	/** サポートする動画ファイル拡張子 */
	VIDEO_EXTENSIONS: [
		'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm'
	] as string[],

	/** 全てのサポートされる拡張子（後方互換性のため） */
	EXTENSIONS: [
		'mp3', 'm4a', 'wav', 'flac', 'ogg', 'aac',
		'mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm'
	] as string[],

	/** MIMEタイプマッピング */
	MIME_TYPES: {
		'mp3': 'audio/mpeg',
		'mp4': 'video/mp4',
		'm4v': 'video/x-m4v',
		'm4a': 'audio/mp4',
		'wav': 'audio/wav',
		'flac': 'audio/flac',
		'aac': 'audio/aac',
		'ogg': 'audio/ogg',
		'webm': 'video/webm',
		'mov': 'video/quicktime',
		'avi': 'video/x-msvideo',
		'mkv': 'video/x-matroska'
	}
} as const;

/**
 * タイムアウト関連の定数 (ms)
 */
export const TIMEOUT_CONSTANTS = {
	/** API リクエストタイムアウト (5分) */
	API_REQUEST: 300000,
	/** デフォルトリクエストタイムアウト (60秒) */
	DEFAULT_REQUEST: 60000,
	/** プログレス更新間隔 (5秒) */
	PROGRESS_UPDATE_DELAY: 5000,
	/** UI更新間隔 (1秒) */
	UI_UPDATE_INTERVAL: 1000
} as const;

/**
 * 暗号化関連の定数
 */
export const CRYPTO_CONSTANTS = {
	/** PBKDF2反復回数 */
	PBKDF2_ITERATIONS: 10000,
	/** キーサイズ (ビット) */
	KEY_SIZE_BITS: 256,
	/** ソルトサイズ (バイト) */
	SALT_SIZE_BYTES: 32
} as const;

/**
 * API エンドポイント
 */
export const API_ENDPOINTS = {
	OPENAI: {
		BASE_URL: 'https://api.openai.com/v1',
		TRANSCRIPTIONS: '/audio/transcriptions',
		TRANSLATIONS: '/audio/translations',
		CHAT_COMPLETIONS: '/chat/completions'
	}
} as const;

/**
 * モデル名定数
 */
export const MODEL_NAMES = {
	WHISPER: 'whisper-1',
	WHISPER_TS: 'whisper-1-ts',
	GPT4O: 'gpt-4o-transcribe',
	GPT4O_MINI: 'gpt-4o-mini-transcribe'
} as const;

/**
 * エラーメッセージ
 */
export const ERROR_MESSAGES = {
	NO_API_KEY: 'APIキーが設定されていません',
	FILE_TOO_LARGE: 'ファイルサイズが制限を超えています',
	UNSUPPORTED_FORMAT: 'サポートされていないファイル形式です',
	CONNECTION_FAILED: 'API接続に失敗しました',
	TRANSCRIPTION_FAILED: '文字起こしに失敗しました'
} as const;

/**
 * UI 表示関連の定数
 */
export const UI_CONSTANTS = {
	/** 通知表示時間 (ms) */
	NOTICE_DURATION: 6000,

	/** 履歴管理 */
	MAX_HISTORY_ITEMS: 50, // 固定値：最大履歴保持件数
	HISTORY_CLEANUP_THRESHOLD: 60, // クリーンアップ実行閾値

	/** プレビュー表示 */
	PREVIEW_LENGTH: 50 // プレビュー文字数
} as const;

/**
 * ファイルサイズなどの制限値
 */
export const APP_LIMITS = {
	/** 大きなファイルの警告サイズ (MB) */
	LARGE_FILE_WARNING_SIZE_MB: 500
} as const;

/**
 * プロンプト関連の定数
 */
export const PROMPT_CONSTANTS = {
	/** コンテキストスニペットの最小長 (文字) */
	CONTEXT_SNIPPET_MIN_LENGTH: 30,
	/** コンテキストスニペットのバッファ (文字) */
	CONTEXT_SNIPPET_BUFFER: 50,
	/** コンテキストの末尾長 (文字) */
	CONTEXT_TAIL_LENGTH: 500,
	/** チャンクのオーバーラップ時間 (秒) */
	CHUNK_OVERLAP_SECONDS: 30
} as const;

/**
 * 辞書関連の定数
 */
export const DICTIONARY_CONSTANTS = {
	/** 固定補正の最大個数 */
	MAX_DEFINITE_CORRECTIONS: 50,

	/** 文脈補正の最大個数 */
	MAX_CONTEXTUAL_CORRECTIONS: 150,

	/** 補正カテゴリ（IMEの品詞分類を参考） */
	CATEGORIES: [
		'noun',      // 名詞
		'person',    // 人名
		'place',     // 地名
		'org',       // 組織名
		'proper',    // その他固有名詞
		'technical', // 専門用語
		'spoken',    // 話し言葉
		'symbol'     // 記号・単位
	] as const,

	/** デフォルトカテゴリ */
	DEFAULT_CATEGORY: 'noun' as const,

	/** 優先度の範囲 */
	PRIORITY_RANGE: [1, 2, 3, 4, 5] as const,

	/** デフォルト優先度 */
	DEFAULT_PRIORITY: 3
} as const;

/**
 * ファイルタイプ判定ヘルパー関数
 */
export const FileTypeUtils = {
	/**
	 * ファイルが音声ファイルかどうかを判定
	 */
	isAudioFile(extension: string): boolean {
		return SUPPORTED_FORMATS.AUDIO_EXTENSIONS.includes(extension.toLowerCase());
	},

	/**
	 * ファイルが動画ファイルかどうかを判定
	 */
	isVideoFile(extension: string): boolean {
		return SUPPORTED_FORMATS.VIDEO_EXTENSIONS.includes(extension.toLowerCase());
	},

	/**
	 * ファイルがサポートされているかどうかを判定
	 */
	isSupportedFile(extension: string): boolean {
		return SUPPORTED_FORMATS.EXTENSIONS.includes(extension.toLowerCase());
	}
} as const;
