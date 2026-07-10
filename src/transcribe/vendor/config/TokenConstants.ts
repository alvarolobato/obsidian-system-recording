/**
 * Token-to-character ratio constants based on empirical data
 *
 * These values represent the average number of characters per token
 * for different languages when using OpenAI's cl100k/tiktoken tokenizer.
 *
 * Reference values (characters per token):
 * - English: ~4 chars/token (OpenAI official guidance: "approximately 3-4 characters")
 * - Japanese: ~1.2-1.6 chars/token (1 kanji ≈ 1 token, kana often 1-2 tokens)
 * - Chinese: ~1.0-1.3 chars/token (1 character ≈ 1 token in most cases)
 *
 * Note: Actual values vary based on content, mixed alphanumeric characters, and symbols.
 */

export const TOKEN_CHAR_RATIOS = {
	// Average characters per token for each language
	ENGLISH: 4.0,
	JAPANESE: 1.4,     // Average of 1.2-1.6 range
	CHINESE: 1.15,     // Average of 1.0-1.3 range
	KOREAN: 1.5,       // Similar to Japanese
	MIXED: 2.5,        // Default for mixed content
	DEFAULT: 3.0       // Conservative default
} as const;

/**
 * Inverse ratios (tokens per character) for convenience
 * These are useful for estimating token usage from character count
 */
export const TOKENS_PER_CHAR = {
	ENGLISH: 0.25,     // 1/4.0
	JAPANESE: 0.71,    // 1/1.4 ≈ 0.71
	CHINESE: 0.87,     // 1/1.15 ≈ 0.87
	KOREAN: 0.67,      // 1/1.5 ≈ 0.67
	MIXED: 0.4,        // 1/2.5
	DEFAULT: 0.33      // 1/3.0
} as const;

/**
 * Get characters per token ratio for a given language
 */
export function getCharsPerToken(language: string): number {
	switch (language.toLowerCase()) {
	case 'en':
	case 'eng':
	case 'english':
		return TOKEN_CHAR_RATIOS.ENGLISH;
	case 'ja':
	case 'jpn':
	case 'japanese':
		return TOKEN_CHAR_RATIOS.JAPANESE;
	case 'zh':
	case 'zho':
	case 'chinese':
	case 'zh-cn':
	case 'zh-tw':
		return TOKEN_CHAR_RATIOS.CHINESE;
	case 'ko':
	case 'kor':
	case 'korean':
		return TOKEN_CHAR_RATIOS.KOREAN;
	case 'auto':
	case 'mixed':
		return TOKEN_CHAR_RATIOS.MIXED;
	default:
		return TOKEN_CHAR_RATIOS.DEFAULT;
	}
}

/**
 * Estimate token count from text length
 * For precise counting, use tiktoken library instead
 */
export function estimateTokenCount(text: string, language = 'auto'): number {
	const charsPerToken = getCharsPerToken(language);
	return Math.ceil(text.length / charsPerToken);
}

/**
 * Estimate character count from token limit
 */
export function estimateCharCount(tokenLimit: number, language = 'auto'): number {
	const charsPerToken = getCharsPerToken(language);
	return Math.floor(tokenLimit * charsPerToken);
}