/**
 * Dictionary correction configuration
 * Centralized configuration for dictionary-based text correction
 */

export const DICTIONARY_CORRECTION_CONFIG = {
	// GPT correction settings
	gpt: {
		model: 'gpt-4o-mini',
		temperature: 0.1,
		maxTokens: 2000,
		maxHints: 20,
		timeout: 30000 // 30 seconds
	},

	// Correction limits (matching DICTIONARY_CONSTANTS)
	limits: {
		maxDefiniteCorrections: 50,
		maxContextualCorrections: 150,
		maxRuleBasedEntries: 20
	},

	// Default priorities
	defaultPriority: 3
} as const;