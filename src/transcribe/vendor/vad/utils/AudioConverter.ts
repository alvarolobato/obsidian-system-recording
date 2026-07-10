/**
 * 音声フォーマット変換ユーティリティ
 */
export class AudioConverter {
	private audioContext: AudioContext | null = null;

	constructor() {
		// AudioContextは必要時に初期化
	}

	/**
   * 音声ファイルをデコードしてFloat32Arrayに変換
   */
	async decodeAudioFile(
		audioBuffer: ArrayBuffer,
			fileExtension: string
	): Promise<{ audioData: Float32Array; sampleRate: number }> {
			try {
				// AudioContextを初期化（遅延初期化）
				const audioContext = this.audioContext ?? new AudioContext();
				this.audioContext = audioContext;

				// AudioBufferにデコード
				const decodedAudio = await audioContext.decodeAudioData(
					audioBuffer.slice(0) // コピーを作成
			);

			// モノラルに変換（VAD処理用）
			const audioData = this.convertToMono(decodedAudio);

			return {
				audioData,
				sampleRate: decodedAudio.sampleRate
			};
		} catch (error: unknown) {
			const errorMessage = this.formatUnknownError(error);
			throw new Error(
				`Failed to decode audio file (${fileExtension}): ${errorMessage}`
			);
		}
	}

	/**
   * Float32ArrayをWAVフォーマットにエンコード
   */
	encodeToWAV(
		audioData: Float32Array,
		sampleRate: number
	): Promise<ArrayBuffer> {
		// WAVヘッダーのサイズ
		const headerSize = 44;

		// 16ビットPCMに変換
		const pcmData = this.float32ToInt16(audioData);

		// WAVファイルのサイズを計算
		const fileSize = headerSize + pcmData.byteLength;

		// ArrayBufferとDataViewを作成
		const buffer = new ArrayBuffer(fileSize);
		const view = new DataView(buffer);

		// WAVヘッダーを書き込み
		this.writeWAVHeader(view, pcmData.byteLength, sampleRate);

		// PCMデータを書き込み
		const uint8Array = new Uint8Array(buffer);
		uint8Array.set(new Uint8Array(pcmData.buffer), headerSize);

		return Promise.resolve(buffer);
	}

	/**
   * ステレオ/マルチチャンネルをモノラルに変換
   */
	private convertToMono(audioBuffer: AudioBuffer): Float32Array {
		if (audioBuffer.numberOfChannels === 1) {
			// すでにモノラル
			return audioBuffer.getChannelData(0);
		}

		// 全チャンネルの平均を計算
		const length = audioBuffer.length;
		const mono = new Float32Array(length);
		const numberOfChannels = audioBuffer.numberOfChannels;

		for (let i = 0; i < length; i++) {
			let sum = 0;
			for (let channel = 0; channel < numberOfChannels; channel++) {
				const channelData = audioBuffer.getChannelData(channel);
				sum += channelData[i] ?? 0;
			}
			mono[i] = sum / numberOfChannels;
		}

		return mono;
	}

	/**
   * Float32Array (-1 to 1) を Int16Array (-32768 to 32767) に変換
   */
	private float32ToInt16(float32Array: Float32Array): Int16Array {
		const int16Array = new Int16Array(float32Array.length);

		for (let i = 0; i < float32Array.length; i++) {
			// クリッピング
			let value = Math.max(-1, Math.min(1, float32Array[i] ?? 0));

			// スケーリング
			value = value < 0 ? value * 32768 : value * 32767;

			// 整数に変換
			int16Array[i] = Math.round(value);
		}

		return int16Array;
	}

	/**
   * WAVヘッダーを書き込み
   */
	private writeWAVHeader(
		view: DataView,
		dataSize: number,
		sampleRate: number
	): void {
		const channels = 1; // モノラル
		const bitsPerSample = 16;
		const bytesPerSample = bitsPerSample / 8;
		const blockAlign = channels * bytesPerSample;
		const byteRate = sampleRate * blockAlign;

		// "RIFF"
		view.setUint8(0, 0x52); // R
		view.setUint8(1, 0x49); // I
		view.setUint8(2, 0x46); // F
		view.setUint8(3, 0x46); // F

		// ファイルサイズ - 8
		view.setUint32(4, 36 + dataSize, true);

		// "WAVE"
		view.setUint8(8, 0x57);  // W
		view.setUint8(9, 0x41);  // A
		view.setUint8(10, 0x56); // V
		view.setUint8(11, 0x45); // E

		// "fmt "
		view.setUint8(12, 0x66); // f
		view.setUint8(13, 0x6D); // m
		view.setUint8(14, 0x74); // t
		view.setUint8(15, 0x20); // space

		// fmt チャンクサイズ
		view.setUint32(16, 16, true);

		// オーディオフォーマット (1 = PCM)
		view.setUint16(20, 1, true);

		// チャンネル数
		view.setUint16(22, channels, true);

		// サンプリングレート
		view.setUint32(24, sampleRate, true);

		// バイトレート
		view.setUint32(28, byteRate, true);

		// ブロックアライン
		view.setUint16(32, blockAlign, true);

		// ビット深度
		view.setUint16(34, bitsPerSample, true);

		// "data"
		view.setUint8(36, 0x64); // d
		view.setUint8(37, 0x61); // a
		view.setUint8(38, 0x74); // t
		view.setUint8(39, 0x61); // a

		// データチャンクサイズ
		view.setUint32(40, dataSize, true);
	}

	/**
   * クリーンアップ
   */
	cleanup(): void {
		if (this.audioContext) {
			const closePromise = this.audioContext.close();
			closePromise.catch((error) => {
				console.warn('Failed to close AudioContext in AudioConverter', error);
			});
			this.audioContext = null;
		}
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
}
