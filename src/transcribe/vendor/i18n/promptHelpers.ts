/**
 * Helpers for i18n prompt handling
 * Provides utilities for parameter replacement and multi-line prompt management
 */

import { t } from './index';

function formatParamValue(value: unknown): string {
	if (value === null || value === undefined) {
		return '';
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	try {
		return JSON.stringify(value);
	} catch {
		return '';
	}
}

/**
 * Replace parameters in a prompt template
 * Supports both single value and object parameter replacement
 *
 * @param template - The prompt template with {param} placeholders
 * @param params - Either a single value or an object with key-value pairs
 * @returns The processed prompt with parameters replaced
 */
export function replacePromptParams(
	template: string,
	params: Record<string, unknown> | string
): string {
	if (typeof params === 'string') {
		// Simple replacement for single parameter
		return template.replace(/{[^}]+}/g, params);
	}

	// Object-based replacement
	let result = template;
	for (const [key, value] of Object.entries(params)) {
		// Support both {key} and {key:default} patterns
		const regex = new RegExp(`\\{${key}(?::[^}]*)?\\}`, 'g');
		result = result.replace(regex, formatParamValue(value));
	}

	// Handle any remaining placeholders with defaults
	result = result.replace(/{([^:}]+):([^}]*)}/g, '$2');

	// Remove any unmatched placeholders
	result = result.replace(/{[^}]+}/g, '');

	return result;
}

/**
 * Get a prompt with automatic language detection
 * Falls back to English if the specified language is not available
 *
 * @param key - The prompt key (e.g., 'prompts.postProcessing.metaReduction.system')
 * @param language - The target language code
 * @param params - Optional parameters for replacement
 * @returns The localized and parameterized prompt
 */
export function getPrompt(
	key: string,
	_language = 'en',
	params?: Record<string, unknown>
): string {
	// Get the localized prompt
	const prompt = t(key);

	// If no parameters, return as-is
	if (!params) {
		return prompt;
	}

	// Replace parameters
	return replacePromptParams(prompt, params);
}

/**
 * Build a multi-part prompt from components
 * Useful for constructing complex prompts with conditional sections
 *
 * @param parts - Array of prompt parts (strings or undefined/null values are filtered out)
 * @param separator - Separator between parts (default: double newline)
 * @returns The combined prompt
 */
export function buildMultiPartPrompt(
	parts: (string | undefined | null)[],
	separator = '\n\n'
): string {
	return parts
		.filter((part): part is string => Boolean(part))
		.join(separator)
		.trim();
}

/**
 * Format a prompt with proper indentation
 * Preserves the structure of multi-line prompts
 *
 * @param prompt - The prompt to format
 * @param indent - Number of spaces to indent (default: 0)
 * @returns The formatted prompt
 */
export function formatPrompt(prompt: string, indent = 0): string {
	if (indent === 0) {
		return prompt;
	}

	const indentStr = ' '.repeat(indent);
	return prompt
		.split('\n')
		.map((line, index) => {
			// Don't indent the first line if it's empty
			if (index === 0 && line.trim() === '') {
				return line;
			}
			return indentStr + line;
		})
		.join('\n');
}

/**
 * Validate that all required parameters are present in a prompt
 * Useful for debugging and ensuring prompt completeness
 *
 * @param template - The prompt template
 * @param params - The parameters object
 * @returns Array of missing parameter names
 */
export function validatePromptParams(
	template: string,
	params: Record<string, unknown>
): string[] {
	const requiredParams = new Set<string>();
	const paramRegex = /{([^:}]+)(?::[^}]*)?}/g;

	let match;
	while ((match = paramRegex.exec(template)) !== null) {
		const key = match[1];
		if (key) {
			requiredParams.add(key);
		}
	}

	const missingParams: string[] = [];
	for (const param of requiredParams) {
		if (!(param in params)) {
			missingParams.push(param);
		}
	}

	return missingParams;
}

/**
 * Truncate a prompt to fit within token limits
 * Attempts to truncate at sentence boundaries
 *
 * @param prompt - The prompt to truncate
 * @param maxChars - Maximum character count
 * @param suffix - Optional suffix to add when truncated (default: '...')
 * @returns The truncated prompt
 */
export function truncatePrompt(
	prompt: string,
	maxChars: number,
	suffix = '...'
): string {
	if (prompt.length <= maxChars) {
		return prompt;
	}

	// Account for suffix length
	const targetLength = maxChars - suffix.length;
	if (targetLength <= 0) {
		return suffix;
	}

	// Try to truncate at sentence boundary
	const truncated = prompt.substring(0, targetLength);
	const sentenceEnds = ['. ', '。', '! ', '? ', '！', '？'];

	let bestBreakPoint = -1;
	for (const ending of sentenceEnds) {
		const lastIndex = truncated.lastIndexOf(ending);
		if (lastIndex > bestBreakPoint) {
			bestBreakPoint = lastIndex + ending.length - 1;
		}
	}

	if (bestBreakPoint > targetLength * 0.8) {
		return prompt.substring(0, bestBreakPoint + 1).trim() + suffix;
	}

	// Fall back to word boundary
	const lastSpace = truncated.lastIndexOf(' ');
	if (lastSpace > targetLength * 0.8) {
		return prompt.substring(0, lastSpace).trim() + suffix;
	}

	// Last resort: hard truncate
	return truncated.trim() + suffix;
}

/**
 * Extract language-specific prompt from a nested structure
 * Falls back through language preferences: specified -> English -> first available
 *
 * @param promptObj - Object with language codes as keys
 * @param language - Preferred language code
 * @returns The prompt for the best matching language
 */
export function getLanguageSpecificPrompt(
	promptObj: Record<string, string>,
	language: string
): string {
	// Direct match
	const direct = promptObj[language];
	if (direct) {
		return direct;
	}

	// Fall back to English
	const english = promptObj['en'];
	if (english) {
		return english;
	}

	// Fall back to first available
	const firstKey = Object.keys(promptObj)[0];
	return firstKey ? (promptObj[firstKey] ?? '') : '';
}
