/**
 * Debug utility for overlap detection in transcription merging
 */

import { Logger } from '../../utils/Logger';

export type OverlapMatchKind = 'ngram' | 'exact' | 'normalizedExact';

export interface OverlapMatchLog {
	kind: OverlapMatchKind;
	matchLength: number;
	matchPositionInPrevious: number;
	matchPositionInCurrent: number;
	similarity?: number;
}

export class OverlapDebugger {
	private static logger = Logger.getLogger('OverlapDebugger');
	private static enabled = true;

	static enable() {
		this.enabled = true;
	}

	static disable() {
		this.enabled = false;
	}

	static log(message: string, data?: unknown) {
		if (!this.enabled) {
			return;
		}

		if (data) {
			this.logger.debug(message, data);
		} else {
			this.logger.debug(message);
		}
	}

	static logOverlapDetection(
		previousText: string,
		currentText: string,
		overlapDuration: number,
		estimatedCharsPerSecond: number,
		minMatchLength: number
	) {
		if (!this.enabled) {
			return;
		}

		const estimatedOverlapChars = Math.floor(overlapDuration * estimatedCharsPerSecond);
		const searchStart = Math.max(0, previousText.length - estimatedOverlapChars * 2);
		const searchEnd = Math.min(currentText.length, estimatedOverlapChars * 2);

		this.logger.debug('=== Overlap Detection Analysis ===', {
			previousTextLength: previousText.length,
			currentTextLength: currentText.length,
			overlapDuration,
			estimatedCharsPerSecond,
			minMatchLength,
			estimatedOverlapChars,
			searchRange: {
				start: searchStart,
				end: searchEnd
			}
		});
	}

	static logMatchFound(match: OverlapMatchLog) {
		if (!this.enabled) {
			return;
		}

		this.logger.debug('*** MATCH FOUND ***', match);
	}

	static logNoMatchFound() {
		if (!this.enabled) {
			return;
		}
		this.logger.debug('No overlap match found');
	}

	static logFinalResult(trimmedText: string, connector: string) {
		if (!this.enabled) {
			return;
		}

		this.logger.debug('Final Result', {
			trimmedTextLength: trimmedText.length,
			connector,
			containsTranscriptTags: trimmedText.includes('<TRANSCRIPT>') || trimmedText.includes('</TRANSCRIPT>')
		});
	}
}
