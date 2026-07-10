/**
 * Post-processing configuration for transcription enhancement
 * Used for applying meta information to improve transcription accuracy
 */

import { replacePromptParams } from '../../i18n/promptHelpers';
import { estimateTokenCount as tokenEstimateTokenCount } from '../TokenConstants';

import type { OpenAIChatRequest } from '../../infrastructure/api/openai/OpenAIChatTypes';

export interface PostProcessingConfig {
	endpoint: string;
	model: string;
	defaults: {
		temperature: number;
		maxTokens: number;
		topP: number;
	};
	prompts: {
		metaReduction: {
			system: Record<'ja' | 'en' | 'zh' | 'ko' | 'auto', string>;
			userTemplate: Record<'ja' | 'en' | 'zh' | 'ko' | 'auto', string>;
		};
		postProcessing: {
			system: Record<'ja' | 'en' | 'zh' | 'ko' | 'auto', string>;
			userTemplate: Record<'ja' | 'en' | 'zh' | 'ko' | 'auto', string>;
		};
	};
	limitations: {
		maxInputTokens: number;
		maxOutputTokens: number;
		targetPromptTokens: number;
		maxKeywords: number;
		contextTokenLimit: number;
	};
	segmentation: {
		maxSegmentChars: {
			ja: number;
			en: number;
			zh: number;
			ko: number;
			auto: number;
		};
	};
	metaInfoTemplate: {
		ja: string;
		en: string;
		zh: string;
		ko: string;
		auto: string;
	};
}

export const POST_PROCESSING_CONFIG: PostProcessingConfig = {
	endpoint: '/v1/chat/completions',
	model: 'gpt-4.1-mini-2025-04-14', // GPT-4.1 configuration
	// model: 'o4-mini-2025-04-16', // O4-mini configuration (reasoning model)

	defaults: {
		temperature: 0.0, // Fixed to 0.0 for deterministic output
		maxTokens: 500,
		topP: 0.95
	},

	prompts: {
		metaReduction: {
			system: {
				ja: 'あなたは音声転写用のキーワード抽出器です。与えられたメタ情報から重要なキーワードと文脈を抽出し、指定されたトークン数以内に収めてください。',
				en: 'You are a keyword extractor for speech transcription. Extract important keywords and context from the given metadata and keep it within the specified token count.',
				zh: '您是语音转写的关键词提取器。从给定的元信息中提取重要的关键词和上下文，并保持在指定的令牌数内。',
				ko: '당신은 음성 전사를 위한 키워드 추출기입니다. 주어진 메타 정보에서 중요한 키워드와 맥락을 추출하고 지정된 토큰 수 이내로 유지하세요.',
				auto: 'You are a keyword extractor for speech transcription. Extract important keywords and context from the given metadata and keep it within the specified token count. The metadata may contain multiple languages - extract keywords in their original language without translation.'
			},
			userTemplate: {
				ja: `以下のメタ情報から音声転写に役立つ情報を抽出してください。

メタ情報:
{metaInfo}

言語: {language}

以下のJSON形式で回答してください:
{
  "keywords": ["keyword1", "keyword2", ...], // 最大{maxKeywords}個、専門用語や固有名詞を優先
  "context": "簡潔な文脈説明", // 最大{contextTokenLimit}トークン
  "language": "{language}"
}`,
				en: `Extract information useful for speech transcription from the following metadata.

Metadata:
{metaInfo}

Language: {language}

Please respond in the following JSON format:
{
  "keywords": ["keyword1", "keyword2", ...], // Maximum {maxKeywords} items, prioritize technical terms and proper nouns
  "context": "Concise context description", // Maximum {contextTokenLimit} tokens
  "language": "{language}"
}`,
				zh: `从以下元信息中提取对语音转写有用的信息。

元信息:
{metaInfo}

语言: {language}

请以以下JSON格式回答:
{
  "keywords": ["keyword1", "keyword2", ...], // 最多{maxKeywords}个，优先选择专业术语和专有名词
  "context": "简洁的上下文说明", // 最多{contextTokenLimit}个令牌
  "language": "{language}"
}`,
				ko: `다음 메타 정보에서 음성 전사에 유용한 정보를 추출하세요.

메타 정보:
{metaInfo}

언어: {language}

다음 JSON 형식으로 답변해주세요:
{
  "keywords": ["keyword1", "keyword2", ...], // 최대 {maxKeywords}개, 전문 용어와 고유 명사를 우선시
  "context": "간결한 맥락 설명", // 최대 {contextTokenLimit} 토큰
  "language": "{language}"
}`,
				auto: `Extract information useful for speech transcription from the following metadata.

Metadata:
{metaInfo}

Language: auto-detect (metadata may contain multiple languages)

Please respond in the following JSON format:
{
  "keywords": ["keyword1", "keyword2", ...], // Maximum {maxKeywords} items, prioritize technical terms and proper nouns in their original language
  "context": "Concise context description", // Maximum {contextTokenLimit} tokens
  "language": "auto"
}`
			}
		},
		postProcessing: {
			system: {
				ja: 'あなたは日本語音声転写の専門的な校正者です。音声認識の誤りを修正し、自然な日本語に整えてください。重要：転写内容を途中で切らず、必ず最後まで処理してください。',
				en: 'You are a professional proofreader for English speech transcription. Correct speech recognition errors and make the text natural. Important: Process the entire transcription without cutting it off.',
				zh: '您是中文语音转写的专业校对员。纠正语音识别错误，使文本自然流畅。重要提示：不要中断转写内容，必须处理到最后。',
				ko: '당신은 한국어 음성 전사의 전문 교정자입니다. 음성 인식 오류를 수정하고 자연스러운 한국어로 다듬어주세요. 중요: 전사 내용을 중간에 자르지 말고 반드시 끝까지 처리하세요.',
				auto: 'You are a professional proofreader for multilingual speech transcription. Correct speech recognition errors while preserving the original languages used. Important: Process the entire transcription without cutting it off and do not translate between languages.'
			},
			userTemplate: {
				ja: `以下の音声転写結果を校正してください。

メタ情報の文脈:
{context}

重要キーワード（これらの単語は正しい表記です）:
{keywords}

転写結果:
{transcription}

校正の指針:
1. キーワードリストにある単語は正しい表記として扱い、転写結果内の類似した誤認識を修正してください
2. 明らかな音声認識の誤りのみを修正し、話者の言い回しや口語表現は保持してください
3. 文の区切りや句読点を適切に調整してください
4. 同じ内容の重複部分は削除してください
5. 断片的な言葉や意味不明な部分は、前後の文脈から推測できる場合のみ修正してください
6. 固有名詞や人名は一貫性を保つよう修正してください

出力形式:
- 修正後の全文のみを返してください
- 説明や注釈は一切含めないでください`,
				en: `Please proofread the following speech transcription result.

Meta-context:
{context}

Important Keywords (these words are correctly spelled):
{keywords}

Transcription:
{transcription}

Proofreading Guidelines:
1. Treat words in the keyword list as correct and fix similar misrecognitions in the transcription
2. Only correct obvious speech recognition errors while preserving the speaker's expressions and colloquialisms
3. Adjust sentence breaks and punctuation appropriately
4. Remove duplicate content
5. Only fix fragmented or unclear parts if they can be inferred from context
6. Ensure consistency in proper nouns and names

Output Format:
- Return only the corrected full text
- Do not include any explanations or annotations`,
				zh: `请校对以下语音转写结果。

元信息上下文:
{context}

重要关键词（这些词的拼写是正确的）:
{keywords}

转写结果:
{transcription}

校对指南:
1. 将关键词列表中的词视为正确，修正转写结果中类似的误识别
2. 仅纠正明显的语音识别错误，保留说话者的表达方式和口语化表达
3. 适当调整句子断句和标点符号
4. 删除重复内容
5. 仅在可从上下文推断的情况下修正片段或不清楚的部分
6. 确保专有名词和人名的一致性

输出格式:
- 仅返回修正后的全文
- 不包含任何解释或注释`,
				ko: `다음 음성 전사 결과를 교정해주세요.

메타 정보 맥락:
{context}

중요 키워드 (이 단어들은 올바른 표기입니다):
{keywords}

전사 결과:
{transcription}

교정 지침:
1. 키워드 목록에 있는 단어는 올바른 표기로 취급하고 전사 결과 내 유사한 오인식을 수정하세요
2. 명백한 음성 인식 오류만 수정하고 화자의 말투나 구어체 표현은 유지하세요
3. 문장 구분과 구두점을 적절히 조정하세요
4. 같은 내용의 중복 부분은 삭제하세요
5. 단편적인 말이나 의미불명한 부분은 전후 문맥에서 추측 가능한 경우에만 수정하세요
6. 고유명사와 인명의 일관성을 유지하도록 수정하세요

출력 형식:
- 수정된 전체 텍스트만 반환하세요
- 설명이나 주석은 일절 포함하지 마세요`,
				auto: `Please proofread the following multilingual speech transcription result.

Meta-context:
{context}

Important Keywords (these words are correctly spelled in their respective languages):
{keywords}

Transcription:
{transcription}

Proofreading Guidelines:
1. Treat words in the keyword list as correct and fix similar misrecognitions in the transcription
2. Only correct obvious speech recognition errors while preserving the speaker's expressions and colloquialisms
3. Preserve the original language of each segment - do not translate
4. Adjust sentence breaks and punctuation appropriately for each language
5. Remove duplicate content
6. Only fix fragmented or unclear parts if they can be inferred from context
7. Ensure consistency in proper nouns and names across languages

Output Format:
- Return only the corrected full text
- Do not include any explanations or annotations
- Preserve the original language mix`
			}
		}
	},

	limitations: {
		maxInputTokens: 1047576, // GPT-4.1-miniの実際の入力制限
		maxOutputTokens: 32768, // GPT-4.1-miniの最大出力トークン数
		targetPromptTokens: 200, // Target for Whisper/GPT-4o prompt
		maxKeywords: 30,
		contextTokenLimit: 150
	},

	segmentation: {
		maxSegmentChars: {
			ja: 15000,  // より保守的に（タイムアウト対策）
			en: 40000,  // より保守的に（タイムアウト対策）
			zh: 12000,  // より保守的に（タイムアウト対策）
			ko: 15000,  // 韓国語も日本語と同様の設定
			auto: 40000 // 言語混在の場合は英語と同等に
		}
	},

	metaInfoTemplate: {
		ja: `話者：
トピック・議題：
日時：
場所：
キーワード：
概要：
その他：`,
		en: `Speakers:
Topics/Agenda:
Date/Time:
Location:
Keywords:
Summary:
Notes:`,
		zh: `发言人：
主题/议题：
日期时间：
地点：
关键词：
概要：
备注：`,
		ko: `화자:
주제/안건:
일시:
장소:
키워드:
개요:
기타:`,
		auto: `Speakers:
Topics/Agenda:
Date/Time:
Location:
Keywords:
Summary:
Notes:`
	}
};

/**
 * Get prompt for the specified language
 */
function getPrompt(
	promptSet: Record<'ja' | 'en' | 'zh' | 'ko' | 'auto', string>,
	language: string
): string {
	const lang = language as 'ja' | 'en' | 'zh' | 'ko' | 'auto';
	return promptSet[lang] || promptSet['en'];
}

/**
 * Build request for meta information reduction
 */
export function buildPostProcessingMetaRequest(
	metaInfo: string,
	language: string = 'ja'
): OpenAIChatRequest {

	// Use prompts from config directly instead of i18n
	const systemPrompt = getPrompt(POST_PROCESSING_CONFIG.prompts.metaReduction.system, language);
	const userTemplate = getPrompt(POST_PROCESSING_CONFIG.prompts.metaReduction.userTemplate, language);

	// Replace parameters in the user template
	const prompt = replacePromptParams(userTemplate, {
		metaInfo: metaInfo,
		language: language,
		maxKeywords: POST_PROCESSING_CONFIG.limitations.maxKeywords.toString(),
		contextTokenLimit: POST_PROCESSING_CONFIG.limitations.contextTokenLimit.toString()
	});


	// O4-mini reasoning model configuration (currently not in use)
	// For o4-mini: only max_completion_tokens is supported, temperature/top_p are not
	// if (POST_PROCESSING_CONFIG.model.includes('o4-mini')) {
	// 	return {
	// 		model: POST_PROCESSING_CONFIG.model,
	// 		messages: [
	// 			{
	// 				role: 'system',
	// 				content: POST_PROCESSING_CONFIG.prompts.metaReduction.system
	// 			},
	// 			{
	// 				role: 'user',
	// 				content: prompt
	// 			}
	// 		],
	// 		max_completion_tokens: POST_PROCESSING_CONFIG.defaults.maxTokens,
	// 		response_format: { type: 'json_object' }
	// 	};
	// }

	// For GPT-4.1 and other standard OpenAI models
	return {
		model: POST_PROCESSING_CONFIG.model,
		messages: [
			{
				role: 'system',
				content: systemPrompt
			},
			{
				role: 'user',
				content: prompt
			}
		],
		temperature: POST_PROCESSING_CONFIG.defaults.temperature,
		max_tokens: POST_PROCESSING_CONFIG.defaults.maxTokens,
		top_p: POST_PROCESSING_CONFIG.defaults.topP,
		response_format: { type: 'json_object' }
	};
}

/**
 * Build request for transcription post-processing
 */
export function buildPostProcessingRequest(
	transcription: string,
	context: string,
	keywords: string[],
	language: string = 'ja'
): OpenAIChatRequest {

	// Use prompts from config directly instead of i18n
	const systemPrompt = getPrompt(POST_PROCESSING_CONFIG.prompts.postProcessing.system, language);
	const userTemplate = getPrompt(POST_PROCESSING_CONFIG.prompts.postProcessing.userTemplate, language);

	// Replace parameters in the user template
	const prompt = replacePromptParams(userTemplate, {
		context: context,
		keywords: keywords.join(', '),
		transcription: transcription
	});


	// 言語別の安全なmax_tokens計算
	const safeMaxTokens = calculateSafeMaxTokens(transcription, language);

	// O4-mini reasoning model configuration (currently not in use)
	// For o4-mini: only max_completion_tokens is supported, temperature/top_p are not
	// if (POST_PROCESSING_CONFIG.model.includes('o4-mini')) {
	// 	return {
	// 		model: POST_PROCESSING_CONFIG.model,
	// 		messages: [
	// 			{
	// 				role: 'system',
	// 				content: POST_PROCESSING_CONFIG.prompts.postProcessing.system
	// 			},
	// 			{
	// 				role: 'user',
	// 				content: prompt
	// 			}
	// 		],
	// 		max_completion_tokens: safeMaxTokens
	// 	};
	// }

	// For GPT-4.1 and other standard OpenAI models
	return {
		model: POST_PROCESSING_CONFIG.model,
		messages: [
			{
				role: 'system',
				content: systemPrompt
			},
			{
				role: 'user',
				content: prompt
			}
		],
		temperature: POST_PROCESSING_CONFIG.defaults.temperature,
		max_tokens: safeMaxTokens,
		top_p: POST_PROCESSING_CONFIG.defaults.topP
	};
}

/**
 * Estimate token count (rough estimation)
 * More accurate counting should use tiktoken library
 */
export function estimateTokenCount(text: string, language: string = 'ja'): number {
	// Use centralized token constants
	return tokenEstimateTokenCount(text, language);
}

/**
 * Calculate required max_tokens with language-specific safety margins
 * 余裕を持った係数で設計し、確実に完全な出力を得る
 */
export function calculateSafeMaxTokens(text: string, language: string = 'ja'): number {
	const estimatedTokens = estimateTokenCount(text, language);

	// 言語別の安全係数
	// 日本語：校正で文が長くなることがあるため1.5倍
	// 英語：比較的安定しているため1.3倍
	// 中国語：日本語と同様1.5倍
	// 韓国語：日本語と同様1.5倍
	// auto：言語混在の可能性を考慮して1.4倍
	const safetyFactor = language === 'ja' ? 1.5 :
	                     language === 'en' ? 1.3 :
	                     language === 'zh' ? 1.5 :
	                     language === 'ko' ? 1.5 :
	                     language === 'auto' ? 1.4 :
	                     1.4;

	// 最低保証トークン数（言語別）
	const minTokens = language === 'ja' ? 8192 :
	                  language === 'en' ? 4096 :
	                  language === 'zh' ? 8192 :
	                  language === 'ko' ? 8192 :
	                  language === 'auto' ? 6144 :
	                  6144;

	// 安全係数を適用した必要トークン数
	const requiredTokens = Math.ceil(estimatedTokens * safetyFactor);

	// 最低保証と計算値の大きい方を採用し、上限でキャップ
	return Math.min(
		Math.max(requiredTokens, minTokens),
		POST_PROCESSING_CONFIG.limitations.maxOutputTokens
	);
}

/**
 * Get meta info template for the specified language
 */
export function getMetaInfoTemplate(language: string = 'ja'): string {
	const lang = language as 'ja' | 'en' | 'zh' | 'ko' | 'auto';
	return POST_PROCESSING_CONFIG.metaInfoTemplate[lang] || POST_PROCESSING_CONFIG.metaInfoTemplate['en'];
}
