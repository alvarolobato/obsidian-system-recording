/**
 * OpenAI GPT-4o Transcribe API Configuration
 * Models: gpt-4o-transcribe, gpt-4o-mini-transcribe
 *
 * Reference: https://platform.openai.com/docs/guides/speech-to-text
 */

import { PROMPT_CONSTANTS } from '../constants';

export interface GPT4oTranscribeParams {
	/** Model to use */
	model: 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe';

	/** The audio file to transcribe */
	file: File | Blob;

	/** Response format (limited compared to Whisper) */
	response_format?: 'json' | 'text';

	/** Language of the audio (ISO-639-1) */
	language?: string;

	/** Optional prompt to guide the model */
	prompt?: string;

	/** Previous context for continuation chunks */
	previousContext?: string;

	/** Sampling temperature (0.0-1.0) */
	temperature?: number;

	/** Enable streaming response */
	stream?: boolean;

	/** Include log probabilities (streaming only) */
	include?: ('logprobs')[];
}

export interface GPT4oTranscribeConfig {
	endpoint: string;

	models: {
		'gpt-4o-transcribe': {
			costPerMinute: number;
			displayName: string;
		};
		'gpt-4o-mini-transcribe': {
			costPerMinute: number;
			displayName: string;
		};
	};

	limitations: {
		maxFileSizeMB: number;
		supportedFormats: string[];
		maxDurationMinutes: number;
		supportedResponseFormats: ('json' | 'text')[];
		supportsTimestamps: boolean;
		supportsStreaming: boolean;
	};

	defaults: {
		response_format: 'json' | 'text';
		temperature: number;
		language: string;
		stream: boolean;
	};

	prompts: {
		firstChunk: Record<string, string>;
		continuation: Record<string, string>;
	};
}

export const GPT4O_TRANSCRIBE_CONFIG: GPT4oTranscribeConfig = {
	endpoint: 'https://api.openai.com/v1/audio/transcriptions',

	models: {
		'gpt-4o-transcribe': {
			costPerMinute: 0.006,
			displayName: 'GPT-4o Transcribe'
		},
		'gpt-4o-mini-transcribe': {
			costPerMinute: 0.003,
			displayName: 'GPT-4o Mini Transcribe'
		}
	},

	limitations: {
		maxFileSizeMB: 25, // Same as Whisper
		supportedFormats: ['mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'wav', 'webm'],
		maxDurationMinutes: 30,
		supportedResponseFormats: ['json', 'text'], // No verbose_json, srt, vtt
		supportsTimestamps: false, // No timestamp_granularities support
		supportsStreaming: true
	},

	defaults: {
		response_format: 'json',
		temperature: 0.0, // Fixed to 0.0 for deterministic output
		language: 'ja',
		stream: false
	},

	prompts: {
		// 初回チャンク用のプロンプト（明確な指示で汚染を防ぐ）
		firstChunk: {
			ja: '以下の音声内容のみを文字に起こしてください。この指示文は出力に含めないでください。話者の発言内容だけを正確に記録してください。なお、同じ文やフレーズを繰り返して出力しないでください（ループ禁止）。\n\n出力形式:\n<TRANSCRIPT>\n（話者の発言のみ）\n</TRANSCRIPT>',
			en: 'Transcribe only the spoken content from the audio. Do not include this instruction in your output. Record only what the speaker says. Do not repeat the same sentence or phrase (no looping).\n\nOutput format:\n<TRANSCRIPT>\n(spoken content only)\n</TRANSCRIPT>',
			zh: '仅转录音频中的口语内容。不要在输出中包含此指令。只记录说话者所说的内容。不要重复输出相同的句子或短语（禁止循环）。\n\n输出格式：\n<TRANSCRIPT>\n（仅口语内容）\n</TRANSCRIPT>',
			ko: '오디오의 음성 내용만 텍스트로 변환하십시오. 이 지시문은 출력에 포함하지 마십시오. 화자가 말한 내용만 정확히 기록하십시오. 같은 문장이나 구절을 반복 출력하지 마십시오(루프 금지).\n\n출력 형식:\n<TRANSCRIPT>\n(음성 내용만)\n</TRANSCRIPT>',
			auto: 'Transcribe the spoken content from the audio in its original language(s). Do not translate. Do not include this instruction in your output. Record exactly what the speaker says in the language(s) they use. Do not repeat the same sentence or phrase (no looping).\n\nOutput format:\n<TRANSCRIPT>\n(spoken content in original language(s))\n</TRANSCRIPT>'
		},
		// 継続チャンク用 - 前回末尾のプレースホルダーを含む
		continuation: {
			ja: `以下の音声は前回と約${PROMPT_CONSTANTS.CHUNK_OVERLAP_SECONDS}秒重複しています。\n前回の末尾は次のとおりです（参照用）。**この引用は出力に含めないでください。**\n**この部分より前にあたる音声は一切書き起こさないでください。**\nまた、同じ文やフレーズを繰り返して出力しないでください（ループ禁止）。\n\n[前回の末尾（参照。出力に含めない）]\n{previousTail}\n\n# 指示\n重複を除いた続きのみを文字に起こしてください。前回の末尾と同一の内容は出力しないでください。\n\n# 出力形式\n<TRANSCRIPT>\n（重複を除いた続きの発言のみ）\n</TRANSCRIPT>`,
			en: `The following audio overlaps with the previous chunk by approximately ${PROMPT_CONSTANTS.CHUNK_OVERLAP_SECONDS} seconds.\nThe end of the previous transcription is as follows (for reference). **Do not include this quoted text in your output.**\n**Do not transcribe any audio that comes before this point.**\nAlso, do not repeat the same sentence or phrase (no looping).\n\n[Previous ending (reference; do not output)]\n{previousTail}\n\n# Instructions\nTranscribe only the continuation, excluding any overlap. Do not output anything identical to the previous ending.\n\n# Output format\n<TRANSCRIPT>\n(continuation only, no overlap)\n</TRANSCRIPT>`,
			zh: `以下音频与前一段重叠约${PROMPT_CONSTANTS.CHUNK_OVERLAP_SECONDS}秒。\n前一段的结尾如下（仅供参考）。**不要在输出中包含该引用内容。**\n**请勿转录此点之前的任何音频。**\n另外，不要重复输出相同的句子或短语（禁止循环）。\n\n[前段结尾（参考；不要输出）]\n{previousTail}\n\n# 指示\n仅转录去除重叠后的续集。不要输出与前段结尾相同的内容。\n\n# 输出格式\n<TRANSCRIPT>\n（仅续集，无重叠）\n</TRANSCRIPT>`,
			ko: `다음 오디오는 이전 청크와 약 ${PROMPT_CONSTANTS.CHUNK_OVERLAP_SECONDS}초 겹칩니다.\n이전 전사의 끝은 다음과 같습니다(참조용). **이 인용문은 출력에 포함하지 마십시오.**\n**이 지점 이전의 오디오는 전사하지 마십시오.**\n또한, 같은 문장이나 구절을 반복 출력하지 마십시오(루프 금지).\n\n[이전 끝부분(참조; 출력 금지)]\n{previousTail}\n\n# 지시사항\n중복을 제외한 계속 부분만 전사하십시오. 이전 끝부분과 동일한 내용은 출력하지 마십시오.\n\n# 출력 형식\n<TRANSCRIPT>\n(계속 부분만, 중복 없음)\n</TRANSCRIPT>`,
			auto: `The following audio overlaps with the previous chunk by approximately ${PROMPT_CONSTANTS.CHUNK_OVERLAP_SECONDS} seconds.\nThe end of the previous transcription is as follows (for reference). **Do not include this quoted text in your output.**\n**Do not transcribe any audio that comes before this point.**\nAlso, do not repeat the same sentence or phrase (no looping).\n\n[Previous ending (reference; do not output)]\n{previousTail}\n\n# Instructions\nTranscribe only the continuation in its original language(s), excluding any overlap. Do not translate. Do not output anything identical to the previous ending.\n\n# Output format\n<TRANSCRIPT>\n(continuation in original language(s), no overlap)\n</TRANSCRIPT>`
		}
	}
};

export interface GPT4oTranscribeRequestPayload {
	model: string;
	response_format?: string;
	temperature: number;
	language?: string;
	prompt?: string;
	stream?: boolean;
	include?: string[];
}

/**
 * Build GPT-4o Transcribe API request parameters
 */
export function buildGPT4oTranscribeRequest(
	params: Partial<GPT4oTranscribeParams>,
	isFirstChunk: boolean = true
): GPT4oTranscribeRequestPayload {
	const config = GPT4O_TRANSCRIBE_CONFIG;
	if (!params.model) {
		throw new Error('[GPT4oTranscribeConfig] Model parameter is required');
	}
	const result: GPT4oTranscribeRequestPayload = {
		model: params.model,
		temperature: config.defaults.temperature
	};

	// Required parameter
	// Optional parameters
	if (params.response_format && params.response_format !== config.defaults.response_format) {
		result.response_format = params.response_format;
	}

	// Always use the fixed temperature from config
	// Always include language parameter if specified (not 'auto')
	if (params.language && params.language !== 'auto') {
		result.language = params.language;
	}

	// Prompt handling
	if (params.prompt) {
		result.prompt = params.prompt;
	} else if (params.language) {
		const hasPreviousContext = Boolean(params.previousContext?.trim());
		const shouldUseFirstChunkPrompt = isFirstChunk || !hasPreviousContext;

		const prompts = shouldUseFirstChunkPrompt ? config.prompts.firstChunk : config.prompts.continuation;
		const promptKey = params.language;
		let prompt = prompts[promptKey] ?? prompts['auto'] ?? '';

		// Replace {previousTail} placeholder if we have previous context and it's a continuation chunk
		if (!shouldUseFirstChunkPrompt && params.previousContext) {
			// Extract last characters from previous context based on config
			const tailLength = PROMPT_CONSTANTS.CONTEXT_TAIL_LENGTH;
			const previousTail = params.previousContext.length > tailLength
				? params.previousContext.slice(-tailLength).trim()
				: params.previousContext.trim();

			prompt = prompt.replace('{previousTail}', previousTail);
		}

		result.prompt = prompt || config.prompts.firstChunk['auto'] || '';
	}

	// Streaming support
	if (params.stream !== undefined && params.stream !== config.defaults.stream) {
		result.stream = params.stream;

		// Include logprobs if requested (streaming only)
		if (params.stream && params.include?.includes('logprobs')) {
			result.include = params.include;
		}
	}

	return result;
}

/**
 * Validate file for GPT-4o Transcribe API
 */
export function validateGPT4oTranscribeFile(
	file: File | { size: number; name: string },
	duration?: number
): { valid: boolean; error?: string } {
	const config = GPT4O_TRANSCRIBE_CONFIG;

	// Check file size
	if (file.size > config.limitations.maxFileSizeMB * 1024 * 1024) {
		return {
			valid: false,
			error: `File size (${(file.size / 1024 / 1024).toFixed(1)}MB) exceeds limit of ${config.limitations.maxFileSizeMB}MB`
		};
	}

	// Check file format
	const extension = file.name.split('.').pop()?.toLowerCase() || '';
	if (!config.limitations.supportedFormats.includes(extension)) {
		return {
			valid: false,
			error: `Format '${extension}' not supported. Supported: ${config.limitations.supportedFormats.join(', ')}`
		};
	}

	// Check duration if provided
	if (duration && duration > config.limitations.maxDurationMinutes * 60) {
		return {
			valid: false,
			error: `Duration (${(duration / 60).toFixed(1)}min) exceeds limit of ${config.limitations.maxDurationMinutes}min`
		};
	}

	return { valid: true };
}

/**
 * Get cost estimate for transcription
 */
export function calculateGPT4oTranscribeCost(
	durationMinutes: number,
	model: 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe' = 'gpt-4o-transcribe'
): number {
	return durationMinutes * GPT4O_TRANSCRIBE_CONFIG.models[model].costPerMinute;
}
