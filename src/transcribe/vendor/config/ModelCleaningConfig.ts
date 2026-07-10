/**
 * Model-specific text cleaning configuration
 * Defines which cleaners and settings to use for each transcription model
 */

import { Logger } from '../utils/Logger';

import type {
	PromptContaminationConfig,
	JapaneseValidationConfig,
	GPT4oPipelineOptions,
	TailRepeatConfig,
	ConsecutiveBlockRepeatConfig
} from '../core/transcription/cleaners';

/**
 * Hallucination pattern definitions by language
 */
export interface HallucinationPatterns {
	/** Japanese hallucination patterns */
	japanese: string[];
	/** English hallucination patterns */
	english: string[];
	/** Chinese hallucination patterns */
	chinese: string[];
	/** Korean hallucination patterns */
	korean: string[];
}

/**
 * Configuration for medium-length phrase repetition detection
 */
export interface MediumLengthRepetitionConfig {
	/** Minimum phrase length */
	min: number;
	/** Maximum phrase length */
	max: number;
	/** Minimum repetitions to trigger removal */
	threshold: number;
}

/**
 * Thresholds for repetition detection and handling
 */
export interface RepetitionThresholds {
	/** Base threshold for short character repetition detection */
	baseThreshold: number;
	/** Length factor for dynamic threshold calculation */
	lengthFactor: number;
	/** Essential Japanese particles that should never be mass-deleted */
	essentialParticles: string[];
	/** Common expressions that are often repeated naturally */
	commonExpressions: string[];
	/** Threshold for collapsing repeating sentences */
	sentenceRepetition: number;
	/** Similarity threshold for sentence comparison */
	similarityThreshold: number;
	/** Medium-length phrase repetition ranges */
	mediumLengthRanges?: MediumLengthRepetitionConfig[];
	/** Keep ratio for excessive short character occurrences */
	shortCharKeepRatio?: number;
	/** Minimum count for extreme trailing repetition removal */
	extremeTrailingRepetitionCount?: number;
	/** Minimum sentence length for similarity comparison */
	minimumSentenceLengthForSimilarity?: number;
	/** Consecutive newline limit for formatting */
	consecutiveNewlineLimit?: number;
	/** Dynamic threshold calculation divisor (chars per increment) */
	dynamicThresholdDivisor?: number;
	/** Minimum word length for short char detection */
	shortCharMinLength?: number;
	/** Maximum word length for short char detection */
	shortCharMaxLength?: number;
	/** Maximum consecutive particles allowed */
	maxConsecutiveParticles?: number;
	/** Enumeration repetition detection for handling list hallucinations */
	enumerationDetection?: {
		/** Enable enumeration repetition detection */
		enabled: boolean;
		/** Minimum number of pattern repetitions to trigger compression */
		minRepeatCount?: number;
	};
	/** Particle reduction mode: 'preserve' | 'limit' | 'reduce' */
	particleReductionMode?: 'preserve' | 'limit' | 'reduce';
	/** Paragraph repeat detection configuration */
	paragraphRepeat?: {
		/** Number of characters from the beginning to use as fingerprint */
		headChars: number;
		/** Whether to enable paragraph repeat detection */
		enabled?: boolean;
		/** Comparison mode */
		mode?: 'consecutiveOnly' | 'windowed';
		/** Window size (only used when mode='windowed') */
		windowSize?: number;
		/** Similarity threshold (0-1) after normalization */
		similarityThreshold?: number;
		/** Minimum repeat count to compress */
		minRepeatCount?: number;
	};
}

/**
 * Regular expression patterns for Japanese text validation
 */
export interface ValidationPatterns {
	/** Pattern for detecting incomplete words */
	incompleteWord: string;
	/** Pattern for detecting merged words */
	mergedWord: string;
	/** Pattern for detecting character repetition */
	charRepetition: string;
	/** Pattern for detecting sentence endings */
	sentenceEnding: string;
	/** Array of patterns for detecting strange character sequences */
	strangePatterns: string[];
}

/**
 * Thresholds for Japanese text quality validation
 */
export interface ValidationThresholds {
	/** Maximum allowed katakana ratio */
	katakanaRatio: number;
	/** Minimum length for checking particleless sentences */
	particlelessSentenceLength: number;
	/** Maximum allowed hiragana ratio */
	hiraganaRatio: number;
	/** Minimum expected kanji ratio */
	kanjiRatio: number;
	/** Maximum allowed Latin character ratio */
	latinRatio: number;
}

/**
 * Language-specific configuration
 */
export interface LanguageConfig {
	/** Sentence ending patterns for this language */
	sentenceEndings: string;
	/** Common particles that should not be mass-deleted (for languages like Japanese) */
	essentialParticles?: string[];
	/** Natural repetition expressions */
	commonExpressions?: string[];
}

/**
 * Patterns for detecting and removing prompt contamination
 */
export interface ContaminationPatterns {
	/** Common instruction patterns that might leak into output */
	instructionPatterns: string[];
	/** XML-style tag patterns organized by priority */
	xmlPatternGroups: {
		completeXmlTags: string[];
		sentenceBoundedTags: string[];
		lineBoundedTags: string[];
		standaloneTags: string[];
	};
	/** Context pattern markers in multiple languages */
	contextPatterns: string[];
	/** Lengths for building prompt snippet patterns */
	promptSnippetLengths: number[];
	/** Language-specific configurations */
	languageConfigs?: Record<string, LanguageConfig>;
}


/**
 * Configuration for model-specific cleaning strategies
 */
export interface ModelCleaningStrategy {
	/** Model identifier */
	modelId: string;
	/** Human-readable model name */
	modelName: string;
	/** Pipeline type to use */
	pipelineType: 'whisper' | 'gpt4o' | 'standard';
	/** Whether to enable detailed logging for this model */
	enableDetailedLogging: boolean;
	/** Maximum allowed text reduction ratio */
	maxReductionRatio: number;
	/** Whether to stop pipeline on critical issues */
	stopOnCriticalIssue: boolean;
	/** Prompt contamination cleaner configuration */
	promptContamination?: PromptContaminationConfig;
	/** Japanese text validation configuration */
	japaneseValidation?: JapaneseValidationConfig;
	/** GPT-4o specific pipeline options */
	gpt4oOptions?: GPT4oPipelineOptions;
	/** Pipeline safety thresholds */
	safetyThresholds: SafetyThresholds;
	/** Hallucination pattern definitions by language */
	hallucinationPatterns?: HallucinationPatterns;
	/** Thresholds for repetition detection and handling */
	repetitionThresholds?: RepetitionThresholds;
	/** Regular expression patterns for Japanese text validation */
	validationPatterns?: ValidationPatterns;
	/** Thresholds for Japanese text quality validation */
	validationThresholds?: ValidationThresholds;
	/** Patterns for detecting and removing prompt contamination */
	contaminationPatterns?: ContaminationPatterns;
	/** Tail-repeat (endless loop) compression configuration */
	tailRepeat?: TailRepeatConfig;
	/** Consecutive duplicated block compression configuration */
	consecutiveBlockRepeat?: ConsecutiveBlockRepeatConfig;
	/** Pipeline-level fallback configuration (avoid catastrophic deletion) */
	pipelineFallback?: PipelineFallbackConfig;
}

/**
 * Pipeline-level fallback configuration
 * Used to avoid catastrophic deletion when aggressive deduplication misfires.
 */
export interface PipelineFallbackConfig {
	/** Enable fallback re-run with safer settings */
	enabled: boolean;
	/** Only consider expected-length checks when audioDuration >= this (seconds) */
	minAudioDurationSeconds: number;
	/** Minimum ratio of (actual chars without whitespace) / (expected chars) before fallback */
	minExpectedContentRatio: number;
	/** Absolute minimum final text length before fallback is considered */
	minFinalTextLength: number;
}

/**
 * Safety thresholds for cleaning pipeline
 * All reduction limits to prevent content loss
 */
export interface SafetyThresholds {
	/** Maximum single cleaner reduction ratio before reversion */
	singleCleanerMaxReduction: number;
	/** Maximum single pattern reduction ratio before skipping */
	singlePatternMaxReduction: number;
	/** Emergency fallback threshold for extreme reduction */
	emergencyFallbackThreshold: number;
	/** Warning threshold for suspicious reduction */
	warningThreshold: number;
	/** Maximum patterns matched before warning */
	maxPatternsBeforeWarning: number;
	/** Maximum reduction for repetition patterns (e.g., consecutive word repetitions) */
	repetitionPatternMaxReduction?: number;
	/** Maximum reduction for phrase patterns (e.g., "ご視聴ありがとうございました") */
	phrasePatternMaxReduction?: number;
	/** Maximum cleaning iterations */
	maxCleaningIterations?: number;
	/** Maximum reduction per iteration */
	iterationReductionLimit?: number;
	/** Threshold for triggering excessive reduction warning */
	excessiveReductionWarning?: number;
	/** Threshold for high pattern count warning */
	highPatternCountWarning?: number;
	/** Threshold for significant changes detection */
	significantChangeThreshold?: number;
}

/**
 * Common pattern definitions shared across models
 */
const COMMON_HALLUCINATION_PATTERNS: HallucinationPatterns = {
	japanese: [
		// Remove only CONSECUTIVE repetitions (hallucination pattern)
		// Natural scattered usage in business conversation is preserved
		'/(ありがとうございます[。、]?\\s*){8,}/g',
		'/(ありがとうございました[。、]?\\s*){8,}/g',
		'/(ありがとう[。、]?\\s*){8,}/g',
		'/(すみません[。、]?\\s*){8,}/g',
		'/(はい[。、]?\\s*){8,}/g',
		'/(お願いします[。、]?\\s*){8,}/g',
		// Short word repetitions (lower threshold for very short words)
		'/(うん[。、]?\\s*){20,}/g',
		'/(そう[。、]?\\s*){20,}/g',
		'/(まあ[。、]?\\s*){20,}/g',
		'/(やばい[。、]?\\s*){20,}/g',
		// Meaningless repetitions excluding essential particles
		// Exclude common particles: は, が, を, に, の, で, と, から, まで, より, へ
		'/([あ-んア-ン]{1,4}(?![はがをにのでとからまでよりへ])[。、]?\\s*){30,}/g',
		// Common hallucination endings (only at end of text)
		'/ご視聴ありがとうございました。?$/g',
		'/チャンネル登録お願いします。?$/g',
		// Audio artifacts
		'/\\[音楽\\]/g',
		'/♪～/g',
		// Extreme meaningless repetition
		'/[・\\s]{20,}/g',
		'/\\s*・\\s*・\\s*・\\s*・\\s*・.*$/g'
	],
	english: [
		'/(Thank you\\.?\\s*){5,}/gi',
		'/(Okay\\.?\\s*){5,}/gi',
		'/Thanks for watching\\.?/g',
		'/Please subscribe\\.?/g',
		'/\\[Music\\]/gi',
		'/\\[Applause\\]/gi'
	],
	chinese: [
		'/(谢谢。?\\s*){5,}/g',
		'/(好的。?\\s*){5,}/g',
		'/感谢收看。?/g',
		'/请订阅。?/g',
		'/\\[音乐\\]/g'
	],
	korean: [
		// Consecutive repetitions
		'/(감사합니다[。、]?\\s*){8,}/g',
		'/(고맙습니다[。、]?\\s*){8,}/g',
		'/(네[。、]?\\s*){8,}/g',
		'/(아니요[。、]?\\s*){8,}/g',
		'/(죄송합니다[。、]?\\s*){8,}/g',
		// Short word repetitions
		'/(음[。、]?\\s*){20,}/g',
		'/(어[。、]?\\s*){20,}/g',
		'/(그[。、]?\\s*){20,}/g',
		// Common artifacts
		'/구독해주세요\\.?/g',
		'/시청해주셔서 감사합니다\\.?/g',
		'/\\[음악\\]/g',
		'/\\[박수\\]/g'
	]
};

const COMMON_REPETITION_THRESHOLDS: RepetitionThresholds = {
	baseThreshold: 30,
	lengthFactor: 10,
	essentialParticles: ['は', 'が', 'を', 'に', 'の', 'で', 'と', 'から', 'まで', 'より', 'へ', 'も', 'や', 'か'],
	commonExpressions: ['その', 'この', 'あの', 'って', 'ので', 'けど', 'だけど', 'でも', 'まあ', 'ちょっと'],
	sentenceRepetition: 5,
	similarityThreshold: 0.85,
	mediumLengthRanges: [
		{ min: 5, max: 10, threshold: 3 },    // Short phrases repeated 3+ times
		{ min: 10, max: 20, threshold: 2 },   // Medium phrases repeated 2+ times
		{ min: 20, max: 30, threshold: 2 }    // Longer phrases repeated 2+ times
	],
	shortCharKeepRatio: 0.2,
	extremeTrailingRepetitionCount: 10,
	minimumSentenceLengthForSimilarity: 6,
	consecutiveNewlineLimit: 3,
	dynamicThresholdDivisor: 100,
	shortCharMinLength: 1,
	shortCharMaxLength: 4,
	maxConsecutiveParticles: 5,
	particleReductionMode: 'limit',
	paragraphRepeat: {
		headChars: 15,
		enabled: true,
		mode: 'consecutiveOnly',
		windowSize: 8,
		similarityThreshold: 0.9,
		minRepeatCount: 3
	}
};

const COMMON_VALIDATION_PATTERNS: ValidationPatterns = {
	incompleteWord: '[はがにをでと](?:\\s|$)',
	mergedWord: '[あ-んア-ン]{1,2}[あ-んア-ン]{5,}',
	charRepetition: '(.)\\1{10,}',
	sentenceEnding: '[。！？]',
	strangePatterns: [
		'[あ-ん]{20,}',     // Too many hiragana in sequence
		'[ア-ン]{15,}',     // Too many katakana in sequence
		'[a-zA-Z]{10,}',    // Too much continuous Latin text
		'\\d{6,}'           // Very long numbers
	]
};

const COMMON_VALIDATION_THRESHOLDS: ValidationThresholds = {
	katakanaRatio: 0.3,
	particlelessSentenceLength: 20,
	hiraganaRatio: 0.8,
	kanjiRatio: 0.05,
	latinRatio: 0.2
};

const COMMON_CONTAMINATION_PATTERNS: ContaminationPatterns = {
	instructionPatterns: [
		'以下の音声内容のみを文字に起こしてください。',
		'この指示文は出力に含めないでください。',
		'音声内容のみを文字に起こしてください。',
		'指示文は出力に含めないでください。',
		'前回の内容や指示文は出力に含めないでください。',
		'話者の発言内容だけを正確に記録してください。',
		'正確に文字起こしを行ってください。',
		'適切な句読点を追加し、段落分けを行ってください。',
		'読みやすいように段落分けを行ってください。',
		// English instruction patterns
		'Please transcribe the following audio.',
		'Do not include this instruction in the output.',
		'Transcribe only the audio content.',
		// Chinese instruction patterns
		'请转录以下音频内容。',
		'不要在输出中包含此指令。',
		'仅转录音频内容。'
	],
	xmlPatternGroups: {
		completeXmlTags: [
			'/<前回終了箇所>[^<]*<\\/前回終了箇所>\\s*/g',
			'/<前回の内容>[^<]*<\\/前回の内容>\\s*/g',
			'/<context>[^<]*<\\/context>\\s*/g',
			'/<previous>[^<]*<\\/previous>\\s*/g'
		],
		sentenceBoundedTags: [
			'/<前回終了箇所>[^。！？\\n]{0,50}[。！？]?\\s*/g',
			'/<前回の内容>[^。！？\\n]{0,50}[。！？]?\\s*/g'
		],
		lineBoundedTags: [
			'/<前回終了箇所>[^<\\n]*(?=\\n|<|$)/g',
			'/<前回の内容>[^<\\n]*(?=\\n|<|$)/g',
			'/<context>[^<\\n]*(?=\\n|<|$)/g',
			'/<previous>[^<\\n]*(?=\\n|<|$)/g'
		],
		standaloneTags: [
			'/<前回終了箇所>\\s*/g',
			'/<前回の内容>\\s*/g',
			'/<context>\\s*/g',
			'/<previous>\\s*/g'
		]
	},
	contextPatterns: [
		'/^Context:\\s*"[^"]+"\\s*/gm',
		'/^前の文脈:\\s*"[^"]+"\\s*/gm',
		'/^上文:\\s*"[^"]+"\\s*/gm',
		'/^이전 문맥:\\s*"[^"]+"\\s*/gm',
		'/^Previous context:\\s*"[^"]+"\\s*/gm',
		'/^続き:\\s*"[^"]+"\\s*/gm',
		'/前回終了箇所[^。！？\\n]*[。！？]?\\s*/g',
		'/前回の内容[^。！？\\n]*[。！？]?\\s*/g',
		'/^前回終了箇所(?=\\S)/gm',
		'/音声を[^。]+文字起こし[^。]+ください。?\\s*続き[:：]\\s*/g',
		'/続き[:：]\\s*全\\d+日分の平均は/g',
		'/^[^\\n]*(?:文字起こし|してください|出力に含めない)[^\\n]*$/gm'
	],
	promptSnippetLengths: [10, 15, 20, 30],
	languageConfigs: {
		'ja': {
			sentenceEndings: '[。、]',
			essentialParticles: ['は', 'が', 'を', 'に', 'の', 'で', 'と', 'から', 'まで', 'より', 'へ', 'も', 'や', 'か'],
			commonExpressions: ['その', 'この', 'あの', 'って', 'ので', 'けど', 'だけど', 'でも', 'まあ', 'ちょっと']
		},
		'en': {
			sentenceEndings: '[.,!?]'
		},
		'zh': {
			sentenceEndings: '[。，！？]',
			essentialParticles: ['的', '了', '在', '是', '和', '与', '或', '但', '而']
		},
		'ko': {
			sentenceEndings: '[.!?]',
			essentialParticles: ['은', '는', '이', '가', '을', '를', '에', '에서', '로', '으로']
		}
	}
};

/**
 * Model cleaning configurations
 */
export const MODEL_CLEANING_STRATEGIES: Record<string, ModelCleaningStrategy> = {
	// Whisper model configuration
	'whisper-1': {
		modelId: 'whisper-1',
		modelName: 'OpenAI Whisper',
		pipelineType: 'whisper',
		enableDetailedLogging: false,
		maxReductionRatio: 0.4, // Conservative for Whisper
		stopOnCriticalIssue: false,
		japaneseValidation: {
			maxReductionRatio: 0.3,
			minTextLength: 60,
			maxIncompleteWords: 3,
			maxMergedWords: 5,
			expectedCharsPerSecond: 2.0, // Whisper tends to be more verbose
			enableAdvancedChecks: true
		},
		safetyThresholds: {
			singleCleanerMaxReduction: 0.3,
			singlePatternMaxReduction: 0.2,
			emergencyFallbackThreshold: 0.7,
			warningThreshold: 0.25,
			maxPatternsBeforeWarning: 15,
			repetitionPatternMaxReduction: 1.0, // 100% - no limit for repetition patterns
			phrasePatternMaxReduction: 0.2, // Same as singlePatternMaxReduction for phrase patterns
			maxCleaningIterations: 3,
			iterationReductionLimit: 0.999,
			excessiveReductionWarning: 0.5,
			highPatternCountWarning: 10,
			significantChangeThreshold: 0.1
		},
		hallucinationPatterns: COMMON_HALLUCINATION_PATTERNS,
		repetitionThresholds: {
			...COMMON_REPETITION_THRESHOLDS,
			// Whisper may need more lenient thresholds for natural speech
			baseThreshold: 35,
			sentenceRepetition: 6
		},
		validationPatterns: COMMON_VALIDATION_PATTERNS,
		validationThresholds: COMMON_VALIDATION_THRESHOLDS,
		tailRepeat: {
			enabled: true,
			maxTailParagraphs: 12,
			maxTailSentences: 40,
			minRepeatCount: 3,
			similarityThreshold: 0.9,
			maxUnitParagraphs: 4,
			maxUnitSentences: 6
		},
		pipelineFallback: {
			enabled: true,
			minAudioDurationSeconds: 60,
			minExpectedContentRatio: 0.1,
			minFinalTextLength: 80
		}
	},

	// Whisper model with timestamp output formatting
	'whisper-1-ts': {
		modelId: 'whisper-1-ts',
		modelName: 'OpenAI Whisper (timestamps)',
		pipelineType: 'whisper',
		enableDetailedLogging: false,
		maxReductionRatio: 0.4,
		stopOnCriticalIssue: false,
		japaneseValidation: {
			maxReductionRatio: 0.3,
			minTextLength: 60,
			maxIncompleteWords: 3,
			maxMergedWords: 5,
			expectedCharsPerSecond: 2.0,
			enableAdvancedChecks: true
		},
		safetyThresholds: {
			singleCleanerMaxReduction: 0.3,
			singlePatternMaxReduction: 0.2,
			emergencyFallbackThreshold: 0.7,
			warningThreshold: 0.25,
			maxPatternsBeforeWarning: 15,
			repetitionPatternMaxReduction: 1.0,
			phrasePatternMaxReduction: 0.2,
			maxCleaningIterations: 3,
			iterationReductionLimit: 0.999,
			excessiveReductionWarning: 0.5,
			highPatternCountWarning: 10,
			significantChangeThreshold: 0.1
		},
		hallucinationPatterns: COMMON_HALLUCINATION_PATTERNS,
		repetitionThresholds: {
			...COMMON_REPETITION_THRESHOLDS,
			baseThreshold: 35,
			sentenceRepetition: 6
		},
		validationPatterns: COMMON_VALIDATION_PATTERNS,
		validationThresholds: COMMON_VALIDATION_THRESHOLDS,
		tailRepeat: {
			enabled: true,
			maxTailParagraphs: 12,
			maxTailSentences: 40,
			minRepeatCount: 3,
			similarityThreshold: 0.9,
			maxUnitParagraphs: 4,
			maxUnitSentences: 6
		},
		pipelineFallback: {
			enabled: true,
			minAudioDurationSeconds: 60,
			minExpectedContentRatio: 0.1,
			minFinalTextLength: 80
		}
	},

	// GPT-4o Mini Transcribe configuration
	'gpt-4o-mini-transcribe': {
		modelId: 'gpt-4o-mini-transcribe',
		modelName: 'GPT-4o Mini Transcribe',
		pipelineType: 'gpt4o',
		enableDetailedLogging: false,
		maxReductionRatio: 0.3, // Conservative to preserve content
		stopOnCriticalIssue: false,
		promptContamination: {
			removeXmlTags: true,
			removeContextPatterns: true,
			aggressiveMatching: false // Conservative by default
		},
		japaneseValidation: {
			maxReductionRatio: 0.25, // Conservative to preserve content
			minTextLength: 50,
			maxIncompleteWords: 8, // Lenient for natural speech
			maxMergedWords: 12, // Lenient for natural speech
			expectedCharsPerSecond: 1.5,
			enableAdvancedChecks: false // Disabled to prevent over-cleaning
		},
		gpt4oOptions: {
			aggressivePromptCleaning: false,
			enableDetailedLogging: false,
			enableJapaneseValidation: true
		},
		safetyThresholds: {
			singleCleanerMaxReduction: 0.25, // Very conservative for GPT-4o
			singlePatternMaxReduction: 0.15, // Conservative pattern matching
			emergencyFallbackThreshold: 0.6, // Emergency preservation
			warningThreshold: 0.2, // Early warning
			maxPatternsBeforeWarning: 10, // Contamination detection
			repetitionPatternMaxReduction: 1.0, // 100% - no limit for repetition patterns
			phrasePatternMaxReduction: 0.15, // Same as singlePatternMaxReduction for phrase patterns
			maxCleaningIterations: 3,
			iterationReductionLimit: 0.999,
			excessiveReductionWarning: 0.5,
			highPatternCountWarning: 10,
			significantChangeThreshold: 0.1
		},
		hallucinationPatterns: COMMON_HALLUCINATION_PATTERNS,
		repetitionThresholds: {
			...COMMON_REPETITION_THRESHOLDS,
			// GPT-4o Mini may be more sensitive, use conservative thresholds
			baseThreshold: 25,
			sentenceRepetition: 4,
			// Enable enumeration repetition detection for list hallucinations
			enumerationDetection: {
				enabled: true,
				minRepeatCount: 3
			}
		},
		consecutiveBlockRepeat: {
			enabled: true,
			minBlockNormalizedChars: 80,
			maxUnitSentences: 20,
			allowSingleSentence: true
		},
		validationPatterns: COMMON_VALIDATION_PATTERNS,
		validationThresholds: {
			...COMMON_VALIDATION_THRESHOLDS,
			// More lenient for GPT-4o Mini natural speech patterns
			katakanaRatio: 0.4,
			hiraganaRatio: 0.85
		},
		contaminationPatterns: COMMON_CONTAMINATION_PATTERNS,
		tailRepeat: {
			enabled: true,
			maxTailParagraphs: 12,
			maxTailSentences: 40,
			minRepeatCount: 3,
			similarityThreshold: 0.9,
			maxUnitParagraphs: 4,
			maxUnitSentences: 6
		},
		pipelineFallback: {
			enabled: true,
			minAudioDurationSeconds: 60,
			minExpectedContentRatio: 0.1,
			minFinalTextLength: 80
		}
	},

	// GPT-4o Transcribe configuration (full model)
	'gpt-4o-transcribe': {
		modelId: 'gpt-4o-transcribe',
		modelName: 'GPT-4o Transcribe',
		pipelineType: 'gpt4o',
		enableDetailedLogging: false,
		maxReductionRatio: 0.25, // Conservative to preserve content
		stopOnCriticalIssue: false,
		promptContamination: {
			removeXmlTags: true,
			removeContextPatterns: true,
			aggressiveMatching: false
		},
		japaneseValidation: {
			maxReductionRatio: 0.2, // Conservative to preserve content
			minTextLength: 60,
			maxIncompleteWords: 6, // Lenient for natural speech
			maxMergedWords: 10, // Lenient for natural speech
			expectedCharsPerSecond: 1.8, // Full model tends to be more accurate
			enableAdvancedChecks: false // Disabled to prevent over-cleaning
		},
		gpt4oOptions: {
			aggressivePromptCleaning: false,
			enableDetailedLogging: false,
			enableJapaneseValidation: true
		},
		safetyThresholds: {
			singleCleanerMaxReduction: 0.2, // Very conservative for full model
			singlePatternMaxReduction: 0.1, // Ultra-conservative pattern matching
			emergencyFallbackThreshold: 0.5, // Early emergency preservation
			warningThreshold: 0.15, // Very early warning
			maxPatternsBeforeWarning: 8, // Strict contamination detection
			repetitionPatternMaxReduction: 1.0, // 100% - no limit for repetition patterns
			phrasePatternMaxReduction: 0.1 // Same as singlePatternMaxReduction for phrase patterns
		},
		hallucinationPatterns: COMMON_HALLUCINATION_PATTERNS,
		repetitionThresholds: {
			...COMMON_REPETITION_THRESHOLDS,
			// Full GPT-4o model with ultra-conservative thresholds
			baseThreshold: 20,
			sentenceRepetition: 3,
			similarityThreshold: 0.90, // Higher similarity required for removal
			// Enable enumeration repetition detection for list hallucinations
			enumerationDetection: {
				enabled: true,
				minRepeatCount: 3
			}
		},
		consecutiveBlockRepeat: {
			enabled: true,
			minBlockNormalizedChars: 80,
			maxUnitSentences: 20,
			allowSingleSentence: true
		},
		validationPatterns: COMMON_VALIDATION_PATTERNS,
		validationThresholds: {
			...COMMON_VALIDATION_THRESHOLDS,
			// Even more lenient for full model's natural speech
			katakanaRatio: 0.5,
			hiraganaRatio: 0.9,
			latinRatio: 0.3
		},
		contaminationPatterns: COMMON_CONTAMINATION_PATTERNS,
		tailRepeat: {
			enabled: true,
			maxTailParagraphs: 12,
			maxTailSentences: 40,
			minRepeatCount: 3,
			similarityThreshold: 0.9,
			maxUnitParagraphs: 4,
			maxUnitSentences: 6
		},
		pipelineFallback: {
			enabled: true,
			minAudioDurationSeconds: 60,
			minExpectedContentRatio: 0.1,
			minFinalTextLength: 80
		}
	}
};

/**
 * Debug configurations for development/troubleshooting
 */
export const DEBUG_CLEANING_STRATEGIES: Record<string, ModelCleaningStrategy> = {
	'gpt-4o-mini-transcribe-debug': {
		...getBaseStrategy('gpt-4o-mini-transcribe'),
		enableDetailedLogging: true,
		maxReductionRatio: 0.1, // Very conservative for debugging
		promptContamination: {
			...getBaseStrategy('gpt-4o-mini-transcribe').promptContamination,
			aggressiveMatching: false // Conservative for debugging
		},
		gpt4oOptions: {
			...getBaseStrategy('gpt-4o-mini-transcribe').gpt4oOptions,
			aggressivePromptCleaning: false, // Conservative for debugging
			enableDetailedLogging: true
		},
		repetitionThresholds: {
			...(getBaseStrategy('gpt-4o-mini-transcribe').repetitionThresholds ?? COMMON_REPETITION_THRESHOLDS),
			lengthFactor: (getBaseStrategy('gpt-4o-mini-transcribe').repetitionThresholds?.lengthFactor ?? COMMON_REPETITION_THRESHOLDS.lengthFactor),
			// Ultra-conservative for debugging
			baseThreshold: 50,
			sentenceRepetition: 8
		}
	},

	'whisper-1-debug': {
		...getBaseStrategy('whisper-1'),
		enableDetailedLogging: true,
		japaneseValidation: {
			...getBaseStrategy('whisper-1').japaneseValidation,
			enableAdvancedChecks: true
		},
		repetitionThresholds: {
			...(getBaseStrategy('whisper-1').repetitionThresholds ?? COMMON_REPETITION_THRESHOLDS),
			lengthFactor: (getBaseStrategy('whisper-1').repetitionThresholds?.lengthFactor ?? COMMON_REPETITION_THRESHOLDS.lengthFactor),
			// More verbose for debugging
			baseThreshold: 45,
			sentenceRepetition: 8
		}
	}
};

function getBaseStrategy(id: string): ModelCleaningStrategy {
	const strategy = MODEL_CLEANING_STRATEGIES[id];
	if (strategy) {
		return strategy;
	}
	// Fallback to default mini strategy; this should never happen for known IDs
	const fallback = MODEL_CLEANING_STRATEGIES['gpt-4o-mini-transcribe'];
	if (!fallback) {
		throw new Error('Default cleaning strategy not found');
	}
	return fallback;
}

/**
 * Get cleaning strategy for a model
 */
export function getModelCleaningStrategy(modelId: string, debug = false): ModelCleaningStrategy {
	const logger = Logger.getLogger('ModelCleaningConfig');
	// Check debug strategies first if debug mode is enabled
	if (debug) {
		const debugStrategy = DEBUG_CLEANING_STRATEGIES[`${modelId}-debug`];
		if (debugStrategy) {
			return debugStrategy;
		}
	}

	// Get standard strategy
	const strategy = MODEL_CLEANING_STRATEGIES[modelId];
	if (!strategy) {
		logger.warn(`No cleaning strategy found for model '${modelId}', using default GPT-4o mini strategy`);
		const fallback = MODEL_CLEANING_STRATEGIES['gpt-4o-mini-transcribe'];
		if (!fallback) {
			throw new Error('Default cleaning strategy not found');
		}
		return fallback;
	}

	return strategy;
}

/**
 * Get all available model IDs with cleaning strategies
 */
export function getAvailableModelIds(): string[] {
	return Object.keys(MODEL_CLEANING_STRATEGIES);
}

/**
 * Check if a model has a cleaning strategy
 */
export function hasCleaningStrategy(modelId: string): boolean {
	return modelId in MODEL_CLEANING_STRATEGIES;
}

/**
 * Get cleaning strategy summary for logging
 */
export function getCleaningStrategySummary(modelId: string, debug = false): string {
	const strategy = getModelCleaningStrategy(modelId, debug);

	return [
		`Model: ${strategy.modelName}`,
		`Pipeline: ${strategy.pipelineType}`,
		`Max reduction: ${Math.round(strategy.maxReductionRatio * 100)}%`,
		`Logging: ${strategy.enableDetailedLogging ? 'ON' : 'OFF'}`,
		debug ? '[DEBUG MODE]' : ''
	].filter(Boolean).join(' | ');
}
