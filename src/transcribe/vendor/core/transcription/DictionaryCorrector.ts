/**
 * Dictionary-based post-processing corrector
 * Applies domain-specific corrections after transcription
 */

import { DICTIONARY_CONSTANTS } from '../../config/constants';
import { Logger } from '../../utils/Logger';

import type { DictionaryEntry as UserDictionaryEntry, ContextualCorrection, DictionaryCategory } from '../../ApiSettings';

// Extended type for internal use
interface ExtendedDictionaryEntry {
	from: string;
	to: string;
	category?: DictionaryCategory;
	priority?: number;
}

export interface DictionaryEntry {
	// 誤認識されやすいパターン（正規表現または文字列）
	pattern: string | RegExp;
	// 正しい表記
	replacement: string;
	// 適用条件（オプション）
	condition?: (text: string) => boolean;
	// 大文字小文字を区別するか
	caseSensitive?: boolean;
	// カテゴリ（GPTプロンプト生成用）
	category?: DictionaryCategory;
	// 優先度（GPTプロンプト生成用）
	priority?: number;
}

export interface CorrectionDictionary {
	// 辞書名
	name: string;
	// 言語コード
	language: string;
	// 辞書エントリ
	entries: DictionaryEntry[];
	// 有効/無効
	enabled: boolean;
	// GPT補正を使用するか
	useGPTCorrection?: boolean;
	// ユーザー辞書の定義補正
	definiteCorrections?: UserDictionaryEntry[];
	// ユーザー辞書の文脈補正
	contextualCorrections?: ContextualCorrection[];
}

/**
 * GPT correction service interface
 */
export interface IGPTCorrectionService {
	correctWithGPT: (text: string, language: string, hints: string[]) => Promise<string>;
}

export class DictionaryCorrector {
	private dictionaries: Map<string, CorrectionDictionary> = new Map();
	private useGPTCorrection: boolean = false;
	private gptService: IGPTCorrectionService | null = null;
	private logger = Logger.getLogger('DictionaryCorrector');

	/**
	 * Constructor
	 */
	constructor(useGPTCorrection: boolean = false, gptService?: IGPTCorrectionService) {
		this.useGPTCorrection = useGPTCorrection;
		this.gptService = gptService ?? null;
	}

	/**
	 * Add or update a dictionary
	 */
	addDictionary(dictionary: CorrectionDictionary): void {
		this.dictionaries.set(dictionary.name, dictionary);
	}

	/**
	 * Remove a dictionary
	 */
	removeDictionary(name: string): void {
		this.dictionaries.delete(name);
	}

	/**
	 * Apply all enabled dictionaries to text
	 */
	async correct(text: string, language: string = 'ja'): Promise<string> {
		let correctedText = text;

		// Apply rule-based corrections first
		for (const dictionary of this.dictionaries.values()) {
			if (!dictionary.enabled) {
				continue;
			}

			// Apply dictionary if it matches the language OR if it's a multi-language dictionary
			if (dictionary.language === language || dictionary.language === 'multi') {
				correctedText = this.applyDictionary(correctedText, dictionary);
			}
		}

		// Apply GPT-based correction if enabled
		if (this.useGPTCorrection && this.gptService) {
			try {
				const hints = this.generateCorrectionHints(text, language);
				correctedText = await this.gptService.correctWithGPT(correctedText, language, hints);
			} catch (error) {
				this.logger.error('GPT correction failed:', error);
				// Fall back to rule-based correction only
			}
		}

		return correctedText;
	}

	/**
	 * Apply a single dictionary to text
	 */
	private applyDictionary(text: string, dictionary: CorrectionDictionary): string {
		let result = text;

		for (const entry of dictionary.entries) {
			// Skip if condition is not met
			if (entry.condition && !entry.condition(result)) {
				continue;
			}

			if (entry.pattern instanceof RegExp) {
				// RegExp pattern
				result = result.replace(entry.pattern, entry.replacement);
			} else {
				// String pattern
				const flags = entry.caseSensitive ? 'g' : 'gi';
				const regex = new RegExp(this.escapeRegex(entry.pattern), flags);
				result = result.replace(regex, entry.replacement);
			}
		}

		return result;
	}

	/**
	 * Escape special regex characters in string
	 */
	private escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}


	/**
	 * Generate correction hints for GPT
	 */
	private generateCorrectionHints(text: string, language: string): string[] {
		const relevantCorrections = this.getRelevantCorrections(text, language);
		return buildCompactCorrectionPrompt(relevantCorrections);
	}


	/**
	 * Get corrections relevant to the text
	 */
	private getRelevantCorrections(text: string, language: string): ExtendedDictionaryEntry[] {
		const corrections: ExtendedDictionaryEntry[] = [];

		for (const dictionary of this.dictionaries.values()) {
			if (!dictionary.enabled) {
				continue;
			}

			// Include dictionary if it matches the language OR if it's a multi-language dictionary
			if (dictionary.language !== language && dictionary.language !== 'multi') {
				continue;
			}

			// Add definite corrections from user dictionary (max 50)
			if (dictionary.definiteCorrections) {
					const definiteEntries = getTopCorrections(dictionary.definiteCorrections, DICTIONARY_CONSTANTS.MAX_DEFINITE_CORRECTIONS)
						.flatMap(entry =>
							// Expand array of patterns to individual entries
							entry.from.map(pattern => {
								const expanded: ExtendedDictionaryEntry = {
									from: pattern,
									to: entry.to
								};
								if (entry.category !== undefined) {
									expanded.category = entry.category;
								}
								if (entry.priority !== undefined) {
									expanded.priority = entry.priority;
								}
								return expanded;
							})
						);
				corrections.push(...definiteEntries);
			}

			// Add relevant contextual corrections (max 150)
			if (dictionary.contextualCorrections) {
				const contextual = detectContextKeywords(text, dictionary.contextualCorrections);
					const topContextual = getTopCorrections(contextual, DICTIONARY_CONSTANTS.MAX_CONTEXTUAL_CORRECTIONS)
						.flatMap(entry =>
							// Expand array of patterns to individual entries
							entry.from.map(pattern => {
								const expanded: ExtendedDictionaryEntry = {
									from: pattern,
									to: entry.to
								};
								if (entry.category !== undefined) {
									expanded.category = entry.category;
								}
								if (entry.priority !== undefined) {
									expanded.priority = entry.priority;
								}
								return expanded;
							})
						);
				corrections.push(...topContextual);
			}

			// Add rule-based entries with category info
			for (const entry of dictionary.entries.slice(0, 20)) {
				if (entry.category && entry.priority) {
					corrections.push({
						from: entry.pattern.toString(),
						to: entry.replacement,
						category: entry.category,
						priority: entry.priority
					});
				}
			}
		}

		return corrections;
	}
}


/**
 * Helper functions for dictionary corrections
 */

/**
 * Get top corrections by priority
 */
function getTopCorrections(
	corrections: (UserDictionaryEntry | ContextualCorrection)[],
	limit: number
): (UserDictionaryEntry | ContextualCorrection)[] {
	const defaultPriority = 3; // TODO: Use DICTIONARY_CORRECTION_CONFIG.defaultPriority
	return corrections
		.sort((a, b) => (b.priority ?? defaultPriority) - (a.priority ?? defaultPriority))
		.slice(0, limit);
}

/**
 * Detect context keywords in text
 */
function detectContextKeywords(
	text: string,
	contextualCorrections: ContextualCorrection[]
): ContextualCorrection[] {
	return contextualCorrections.filter(correction => {
		if (!correction.contextKeywords || correction.contextKeywords.length === 0) {
			return false;
		}
		return correction.contextKeywords.some(keyword => text.includes(keyword));
	});
}

/**
 * Build compact correction prompt
 */
function buildCompactCorrectionPrompt(
	corrections: ExtendedDictionaryEntry[]
): string[] {
	// Group by category
	const grouped = corrections.reduce((acc, correction) => {
		const category = correction.category || 'other';
		const items = (acc[category] ??= []);
		items.push(`${correction.from}→${correction.to}`);
		return acc;
	}, {} as Record<string, string[]>);

	// Build hint lines
	const lines: string[] = [];
	for (const [category, items] of Object.entries(grouped)) {
		lines.push(`【${category}】${items.join('、')}`);
	}

	return lines;
}
