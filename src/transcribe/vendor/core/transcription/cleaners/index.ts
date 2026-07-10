/**
 * Text cleaning system exports
 * Modular text cleaning architecture for transcription post-processing
 */

// Interfaces
export type {
	TextCleaner,
	CleaningResult,
	CleaningContext,
	CleaningPipeline,
	PipelineResult,
	CleaningStageResult,
	PipelineConfig
} from './interfaces';

// Individual cleaners
export { BaseHallucinationCleaner } from './BaseHallucinationCleaner';
export { PromptContaminationCleaner } from './PromptContaminationCleaner';
export type { PromptContaminationConfig } from './PromptContaminationCleaner';
export { JapaneseTextValidator } from './JapaneseTextValidator';
export type { JapaneseValidationConfig } from './JapaneseTextValidator';
export { TailRepeatCleaner } from './TailRepeatCleaner';
export type { TailRepeatConfig } from './TailRepeatCleaner';
export { ConsecutiveBlockRepeatCleaner } from './ConsecutiveBlockRepeatCleaner';
export type { ConsecutiveBlockRepeatConfig } from './ConsecutiveBlockRepeatCleaner';
export { TimestampsTailRepeatCleaner } from './TimestampsTailRepeatCleaner';
export type { TimestampsTailRepeatConfig } from './TimestampsTailRepeatCleaner';

// Pipeline implementations
export { StandardCleaningPipeline } from './StandardCleaningPipeline';
export type { GPT4oPipelineOptions } from './GPT4oCleaningPipeline';
