import { Notice, requestUrl } from 'obsidian';

import { t } from '../../i18n';
import { Logger } from '../../utils/Logger';

export class SecurityUtils {
	/**
	 * Validate OpenAI API key format
	 * OpenAI API keys should start with 'sk-' followed by alphanumeric characters
	 */
	static validateOpenAIAPIKey(key: string): { valid: boolean; error?: string } {
		if (!key || key.trim().length === 0) {
			return { valid: false, error: t('errors.apiKeyMissing') };
		}

		// MEETING-COPILOT PATCH: accept any non-empty key so custom
		// OpenAI-compatible gateways (LiteLLM, Azure, …) work, not just
		// `sk-`-prefixed OpenAI keys. See VENDOR.md.
		return { valid: true };
	}

	/**
	 * Test OpenAI API key by making a simple API call
	 * Uses the /models endpoint which is lightweight and reliable
	 */
	static async testOpenAIAPIKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
		// First validate format
		const formatValidation = this.validateOpenAIAPIKey(apiKey);
		if (!formatValidation.valid) {
			return formatValidation;
		}

		try {
			// Note: requestUrl doesn't support AbortController signals like fetch does
			// However, it has built-in timeout handling and cross-platform compatibility

			const response = await requestUrl({
				url: 'https://api.openai.com/v1/models',
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${apiKey.trim()}`,
					'Content-Type': 'application/json'
				},
				throw: false // Don't throw on HTTP error status codes, handle manually
			});

			if (response.status >= 200 && response.status < 300) {
				return { valid: true };
			}

			// Handle specific error cases
			switch (response.status) {
			case 401:
				return { valid: false, error: t('errors.invalidApiKey') };
			case 429:
				return { valid: false, error: t('errors.rateLimitExceeded') };
			case 500:
			case 502:
			case 503:
				return { valid: false, error: t('errors.apiUnavailable') };
			default:
				return {
					valid: false,
					error: t('errors.apiConnectionFailed').replace('{status}', response.status.toString())
				};
			}
		} catch (error) {
			Logger.getLogger('SecurityUtils').error('API test failed:', error);

			return { valid: false, error: t('errors.networkError') };
		}
	}

	/**
	 * Display validation result as Obsidian Notice
	 */
	static showValidationNotice(result: { valid: boolean; error?: string }): void {
		if (result.valid) {
			new Notice(t('settings.apiKey.testSuccess'));
		} else {
			new Notice(result.error || t('settings.apiKey.testFailed'));
		}
	}

	/**
	 * Mask API key for display purposes
	 * Shows first 7 characters and masks the rest
	 */
	static maskApiKey(apiKey: string): string {
		if (!apiKey || apiKey.length < 10) {
			return '';
		}
		return apiKey.substring(0, 7) + '*'.repeat(40);
	}

	/**
	 * Check if a string looks like an API key
	 * Used for detecting plain text keys in settings
	 */
	static looksLikeApiKey(str: string): boolean {
		return /^sk-[a-zA-Z0-9\-_]{20,200}$/.test(str);
	}

	/**
	 * Validate API key with detailed error information
	 * Combines format validation and API testing
	 */
	static async validateApiKey(apiKey: string, showNotice: boolean = true): Promise<{ valid: boolean; error?: string }> {
		// Format validation
		const formatResult = this.validateOpenAIAPIKey(apiKey);
		if (!formatResult.valid) {
			if (showNotice) {
				this.showValidationNotice(formatResult);
			}
			return formatResult;
		}

		// API test
		const testResult = await this.testOpenAIAPIKey(apiKey);
		if (showNotice) {
			this.showValidationNotice(testResult);
		}
		return testResult;
	}
}