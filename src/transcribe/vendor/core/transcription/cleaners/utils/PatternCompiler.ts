/**
 * Utility class for compiling regex patterns from string definitions
 * Provides consistent pattern compilation across different cleaners
 */

import { Logger } from '../../../../utils/Logger';

// Common patterns that can be reused across cleaners
export const GENERIC_XML_TAG = /<\/?[\p{L}\p{N}_-]{1,16}[^>]*?>/gu;
export const META_BRACKET = /\[(音楽|拍手|笑い|Music|Applause|音声|雑音|無音)\]/gi;

export class PatternCompiler {
	/**
	 * Compile a string pattern into RegExp
	 * Handles both regex-format strings (e.g., "/pattern/flags") and literal strings
	 */
		static compile(pattern: string, defaultFlags: string = 'g'): RegExp {
			// Check if pattern is in regex format: /pattern/flags
			const regexMatch = pattern.match(/^\/(.*)\/([gimuy]*)$/);
			if (regexMatch) {
				const patternBody = regexMatch[1];
				const flags = regexMatch[2];
				if (!patternBody) {
					return PatternCompiler.compileLiteral(pattern, defaultFlags);
				}
				return new RegExp(patternBody, flags || defaultFlags);
			}

		// Check if pattern contains regex special characters
		const hasRegexChars = /[\^$\\.*+?[\]{}()|]/.test(pattern);

		if (hasRegexChars) {
			// Pattern likely contains regex syntax, compile with intelligent flag detection
			const flags = PatternCompiler.detectFlags(pattern, defaultFlags);

			try {
				return new RegExp(pattern, flags);
			} catch (e) {
				// If compilation fails, treat as literal string
				const logger = Logger.getLogger('PatternCompiler');
				logger.warn(`Failed to compile pattern as regex: ${pattern}`, e);
				return PatternCompiler.compileLiteral(pattern, defaultFlags);
			}
		}

		// Treat as literal string
		return PatternCompiler.compileLiteral(pattern, defaultFlags);
	}

	/**
	 * Compile an array of patterns
	 */
	static compileMany(patterns: Array<string | undefined>, defaultFlags: string = 'g'): RegExp[] {
		return patterns
			.map(pattern => (typeof pattern === 'string' && pattern.length > 0)
				? PatternCompiler.compile(pattern, defaultFlags)
				: null)
			.filter((pattern): pattern is RegExp => pattern !== null);
	}

	/**
	 * Detect appropriate flags based on pattern content
	 */
	private static detectFlags(pattern: string, defaultFlags: string): string {
		let flags = '';

		// Add multiline flag if pattern uses line anchors or \n
		if (pattern.includes('^') || pattern.includes('$') || pattern.includes('\\n')) {
			flags += 'm';
		}

		// Add case-insensitive flag if pattern has mixed case letters
		if (/[a-z]/.test(pattern) && /[A-Z]/.test(pattern)) {
			flags += 'i';
		}

		// Always include global flag unless explicitly excluded
		if (!flags.includes('g') && defaultFlags.includes('g')) {
			flags += 'g';
		}

		return flags || defaultFlags;
	}

	/**
	 * Compile a literal string by escaping regex special characters
	 */
	private static compileLiteral(literal: string, flags: string): RegExp {
		const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		return new RegExp(escaped, flags);
	}

	/**
	 * Compile language-specific patterns with appropriate modifications
	 */
	static compileWithLanguage(pattern: string, language: string, defaultFlags: string = 'g'): RegExp {
		void language;
		// Language-specific adjustments can be added here
		// For now, just use standard compilation
		return PatternCompiler.compile(pattern, defaultFlags);
	}
}
