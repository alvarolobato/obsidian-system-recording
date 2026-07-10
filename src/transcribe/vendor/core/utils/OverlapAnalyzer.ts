/**
 * Analyzer for understanding overlap issues in transcription merging
 */

import { Logger } from '../../utils/Logger';

import type { ModelConfig } from '../../config/ModelProcessingConfig';

export class OverlapAnalyzer {
	private static logger = Logger.getLogger('OverlapAnalyzer');
	/**
	 * Analyze why overlap detection might be failing
	 */
	static analyzeOverlapProblem(
		previousEndTime: number,
		currentStartTime: number,
		previousText: string,
		currentText: string,
		modelConfig: ModelConfig
	): void {
		this.logger.debug('=== Analyzing Overlap Problem ===');

		// Time analysis
		this.logger.debug('Time Analysis:', {
			previousEndTime,
			currentStartTime,
			overlap: previousEndTime - currentStartTime
		});

		// If there's a time gap instead of overlap
		if (currentStartTime > previousEndTime) {
			this.logger.debug('Time gap detected (no overlap expected)', {
				gap: currentStartTime - previousEndTime
			});
		} else {
			this.logger.debug('Time overlap detected', {
				overlap: previousEndTime - currentStartTime
			});
		}

			// Text analysis
			this.logger.debug('Text Analysis:', {
				previousTextLength: previousText.length,
				currentTextLength: currentText.length,
				previousContainsTranscriptTags: previousText.includes('<TRANSCRIPT>') || previousText.includes('</TRANSCRIPT>'),
				currentContainsTranscriptTags: currentText.includes('<TRANSCRIPT>') || currentText.includes('</TRANSCRIPT>'),
				currentStartsWithTranscriptTag: currentText.trimStart().startsWith('<TRANSCRIPT>')
			});

		// Configuration analysis
		this.logger.debug('Configuration:', modelConfig);

		// Find exact duplicates
		const exactDuplicate = this.findExactDuplicate(previousText, currentText);
		if (exactDuplicate) {
			this.logger.debug('Exact duplicate found', exactDuplicate);
		} else {
			this.logger.debug('No exact duplicate found');
		}

		this.logger.debug('=== Analysis Complete ===');
	}

	/**
	 * Find exact duplicate text between two strings
	 */
		private static findExactDuplicate(
			text1: string,
			text2: string,
			minLength: number = 10
		): { length: number; positionInPrevious: number; positionInCurrent: number } | null {
			// Look for the longest common substring
			let bestMatch = null;
			let maxLength = 0;

		// Search in the last part of text1 and first part of text2
		const searchStart1 = Math.max(0, text1.length - 500);
		const searchEnd2 = Math.min(text2.length, 500);

		for (let i = searchStart1; i < text1.length; i++) {
			for (let j = 0; j < searchEnd2; j++) {
				let k = 0;
				while (
					i + k < text1.length &&
					j + k < text2.length &&
					text1[i + k] === text2[j + k]
				) {
					k++;
				}

					if (k > maxLength && k >= minLength) {
						maxLength = k;
						bestMatch = {
							length: k,
							positionInPrevious: i,
							positionInCurrent: j
						};
				}
			}
		}

		return bestMatch;
	}
}
