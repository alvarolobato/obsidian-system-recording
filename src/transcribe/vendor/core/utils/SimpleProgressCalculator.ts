/**
 * 統一的な進捗計算を行うクラス
 * 10%刻みのシンプルな進捗管理を提供
 */
export class SimpleProgressCalculator {
	private enablePostProcessing: boolean;
	private totalChunks: number;

	constructor(enablePostProcessing: boolean) {
		this.enablePostProcessing = enablePostProcessing;
		this.totalChunks = 1;
	}

	/**
	 * 総チャンク数を更新
	 */
	updateTotalChunks(totalChunks: number): void {
		this.totalChunks = Math.max(1, totalChunks);
	}

	/**
	 * 準備段階の進捗 (0% → 10%)
	 */
	preparationProgress(): number {
		return 10;
	}

	/**
	 * 文字起こし進捗 (10% → 70% or 90%)
	 */
	transcriptionProgress(completedChunks: number): number {
		const endPercent = this.enablePostProcessing ? 70 : 90;
		const range = endPercent - 10;
		const ratio = Math.min(completedChunks / this.totalChunks, 1);
		const rawProgress = 10 + (range * ratio);
		// 10%刻みに丸める
		return Math.round(rawProgress / 10) * 10;
	}

	/**
	 * 後処理進捗 (70% → 90%)
	 */
	postProcessingProgress(stage: 'start' | 'processing' | 'done'): number {
		if (!this.enablePostProcessing) {
			return 90; // 後処理なしの場合は90%固定
		}

		switch (stage) {
		case 'start':
			return 70;
		case 'processing':
			return 80;
		case 'done':
			return 90;
		}
	}

	/**
	 * 完了進捗
	 */
	completionProgress(): number {
		return 100;
	}

	/**
	 * 現在の設定を取得
	 */
	getConfig(): { enablePostProcessing: boolean; totalChunks: number } {
		return {
			enablePostProcessing: this.enablePostProcessing,
			totalChunks: this.totalChunks
		};
	}
}