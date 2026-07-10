/**
 * GPT-based dictionary correction service
 * Infrastructure layer implementation for GPT corrections
 */

import { DICTIONARY_CORRECTION_CONFIG } from '../../../config/DictionaryCorrectionConfig';
import { ResourceManager } from '../../../core/resources/ResourceManager';
import { Logger } from '../../../utils/Logger';
import { ApiClient } from '../ApiClient';
import { getTranscribeBaseUrl } from '../../../../endpointConfig';

import type { IGPTCorrectionService } from '../../../core/transcription/DictionaryCorrector';
import type { OpenAIChatResponse } from '../openai/OpenAIChatTypes';

/**
 * GPT dictionary correction service implementation
 */
export class GPTDictionaryCorrectionService extends ApiClient implements IGPTCorrectionService {
	private resourceManager: ResourceManager;

		constructor(apiKey: string, resourceManager?: ResourceManager) {
			super({
				// MEETING-COPILOT PATCH: base URL from the owned endpoint seam. See VENDOR.md.
				baseUrl: getTranscribeBaseUrl(),
				apiKey: apiKey
			});
			this.resourceManager = resourceManager ?? ResourceManager.getInstance();
			this.logger = Logger.getLogger('GPTDictionaryCorrection');
			this.logger.debug('GPTDictionaryCorrectionService initialized');
		}

	/**
	 * Correct text using GPT model
	 */
	async correctWithGPT(text: string, language: string, hints: string[]): Promise<string> {
		const startTime = performance.now();
		this.logger.debug('Starting GPT correction', {
			language,
			textLength: text.length,
			hintCount: hints.length
		});

		const systemPrompt = this.buildSystemPrompt(language, hints);

		// Dictionary correction is not a post-processing task, so using direct prompts
		const userPrompt = this.getUserPrompt(language, text);

		const requestBody = {
			model: DICTIONARY_CORRECTION_CONFIG.gpt.model,
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userPrompt }
			],
			temperature: DICTIONARY_CORRECTION_CONFIG.gpt.temperature,
			max_tokens: DICTIONARY_CORRECTION_CONFIG.gpt.maxTokens
		};

		// Create abort controller for timeout
		const controller = this.resourceManager.getAbortController('dictionary-gpt-correction');
		const timerWindow = this.getTimerWindow();
		const timeoutId = timerWindow.setTimeout(() => {
			controller.abort();
		}, DICTIONARY_CORRECTION_CONFIG.gpt.timeout);

		try {
			const response = await this.post<OpenAIChatResponse>(
				'/chat/completions',
				requestBody,
				{},
				controller.signal
				);

				timerWindow.clearTimeout(timeoutId);
				const firstChoice = response.choices[0];
				const content = firstChoice?.message?.content;
				if (!content) {
					throw new Error('No content returned from GPT correction request');
				}
				const correctedText = content.trim();

			const elapsedTime = performance.now() - startTime;
			this.logger.info('GPT correction completed', {
				elapsedTime: `${elapsedTime.toFixed(2)}ms`,
				originalLength: text.length,
				correctedLength: correctedText.length,
				tokensUsed: response.usage?.total_tokens
			});

			return correctedText;
		} catch (error) {
			timerWindow.clearTimeout(timeoutId);
			if (error instanceof Error && error.name === 'AbortError') {
				this.logger.error('Request timeout', { timeout: DICTIONARY_CORRECTION_CONFIG.gpt.timeout });
			} else {
				this.logger.error('Correction failed', {
					error: error instanceof Error ? error.message : 'Unknown error',
					language,
					textLength: text.length
				});
			}
			throw error;
		} finally {
			this.resourceManager.cleanupAbortController('dictionary-gpt-correction');
		}
	}

	/**
	 * Build system prompt for GPT correction
	 */
	private buildSystemPrompt(language: string, hints: string[]): string {
		const hintText = hints.slice(0, DICTIONARY_CORRECTION_CONFIG.gpt.maxHints).join('\n');

		// Dictionary correction prompts by language
		const systemPrompts: Record<string, string> = {
			ja: `あなたは日本語の音声認識結果を修正する専門家です。
以下の原則に従って修正してください：

1. 明らかな誤字脱字のみを修正する
2. 話者の意図や文体は変更しない
3. フィラー（「あー」「えー」など）は残す
4. 句読点は適切に追加する
5. 以下のよくある誤認識パターンに注意する：

${hintText}

修正後のテキストのみを返してください。説明は不要です。`,
			en: `You are an expert in correcting speech recognition results.
Please follow these principles:

1. Only correct obvious typos and errors
2. Do not change the speaker's intent or style
3. Keep fillers (like "um", "uh")
4. Add appropriate punctuation
5. Pay attention to these common recognition errors:

${hintText}

Return only the corrected text. No explanations needed.`,
			zh: `您是纠正语音识别结果的专家。
请遵循以下原则：

1. 仅纠正明显的错字和错误
2. 不改变说话者的意图或风格
3. 保留填充词（如"嗯"、"啊"等）
4. 添加适当的标点符号
5. 注意以下常见的识别错误：

${hintText}

仅返回修正后的文本。无需解释。`,
			ko: `당신은 한국어 음성 인식 결과를 수정하는 전문가입니다.
다음 원칙에 따라 수정해주세요:

1. 명백한 오타나 오류만 수정한다
2. 화자의 의도나 문체는 변경하지 않는다
3. 필러("어", "음" 등)는 남긴다
4. 구두점을 적절히 추가한다
5. 다음의 흔한 오인식 패턴에 주의한다:

${hintText}

수정된 텍스트만 반환하세요. 설명은 불필요합니다.`,
			auto: `You are an expert in correcting multilingual speech recognition results.
Please follow these principles:

1. Only correct obvious typos and errors
2. Do not change the speaker's intent or style
3. Keep fillers in their original language
4. Add appropriate punctuation for each language
5. Do not translate between languages
6. Pay attention to these common recognition errors:

${hintText}

Return only the corrected text. No explanations needed.`
		};

			return systemPrompts[language] ?? systemPrompts['auto'] ?? '';
		}

	/**
	 * Get user prompt for the specified language
	 */
	private getUserPrompt(language: string, text: string): string {
		const userPrompts: Record<string, string> = {
			ja: `次のテキストを修正してください: ${text}`,
			en: `Please correct the following text: ${text}`,
			zh: `请修正以下文本: ${text}`,
			ko: `다음 텍스트를 수정해주세요: ${text}`,
			auto: `Please correct the following text (preserve original languages): ${text}`
		};

			return userPrompts[language] ?? userPrompts['auto'] ?? '';
		}

	/**
	 * Test connection to OpenAI API
	 */
	async testConnection(): Promise<boolean> {
		try {
			await this.get<unknown>('/models');
			this.logger.debug('Connection test succeeded');
			return true;
		} catch (error) {
			this.logger.error('Connection test failed', error);
			return false;
		}
	}
}
