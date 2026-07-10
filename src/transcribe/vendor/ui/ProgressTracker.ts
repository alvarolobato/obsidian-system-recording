/**
 * Type-only stub for the vendored TranscriptionController's optional
 * `progressTracker` dependency. Meeting Copilot drives the engine headlessly
 * and never supplies a ProgressTracker, so only the type surface is needed
 * (declared, emits no runtime code). See VENDOR.md.
 */
import type { TFile } from "obsidian";

export interface TranscriptionTask {
	id: string;
	[key: string]: unknown;
}

export declare class ProgressTracker {
	startTask(
		file: TFile,
		totalChunks: number,
		provider: string,
		estimatedCost?: number
	): string;
	updateProgress(
		taskId: string,
		completedChunks: number,
		message?: string,
		unifiedPercentage?: number
	): void;
	updateTotalChunks(taskId: string, totalChunks: number): void;
	completeTask(taskId: string, result: string): void;
	cancelTask(taskId: string): void;
	getCurrentTask(): TranscriptionTask | null;
}
