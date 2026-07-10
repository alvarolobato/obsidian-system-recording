/**
 * Text similarity utilities using n-gram based algorithms
 * Provides fast and efficient text comparison methods
 */

/**
 * Generate n-grams from text
 * @param text The text to generate n-grams from
 * @param n The size of n-grams
 * @returns Map of n-grams to their positions
 */
export function generateNGrams(text: string, n: number): Map<string, number[]> {
	const ngrams = new Map<string, number[]>();

	for (let i = 0; i <= text.length - n; i++) {
		const gram = text.slice(i, i + n);
		if (!ngrams.has(gram)) {
			ngrams.set(gram, []);
		}
		const positions = ngrams.get(gram);
		if (positions) {
			positions.push(i);
		}
	}

	return ngrams;
}

/**
 * Generate n-gram set for similarity calculation
 * @param text The text to generate n-grams from
 * @param n The size of n-grams
 * @returns Set of unique n-grams
 */
export function generateNGramSet(text: string, n: number): Set<string> {
	const ngrams = new Set<string>();

	for (let i = 0; i <= text.length - n; i++) {
		ngrams.add(text.slice(i, i + n));
	}

	return ngrams;
}

/**
 * Calculate Jaccard similarity between two texts using n-grams
 * Fast alternative to edit distance for similarity detection
 * @param text1 First text
 * @param text2 Second text
 * @param nGramSize Size of n-grams to use (default: 3 for short text, 5 for long text)
 * @returns Similarity score between 0 and 1
 */
export function calculateNGramSimilarity(text1: string, text2: string, nGramSize: number = 3): number {
	if (text1 === text2) {
		return 1.0;
	}
	if (text1.length === 0 || text2.length === 0) {
		return 0.0;
	}

	// Adjust n-gram size if texts are too short
	const effectiveNGramSize = Math.min(nGramSize, Math.floor(Math.min(text1.length, text2.length) / 2));
	if (effectiveNGramSize < 1) {
		return 0.0;
	}

	// Generate n-grams for both texts
	const ngrams1 = generateNGramSet(text1, effectiveNGramSize);
	const ngrams2 = generateNGramSet(text2, effectiveNGramSize);

	// Calculate Jaccard similarity (intersection / union)
	let intersection = 0;
	for (const gram of ngrams1) {
		if (ngrams2.has(gram)) {
			intersection++;
		}
	}

	const union = ngrams1.size + ngrams2.size - intersection;
	return union > 0 ? intersection / union : 0.0;
}

/**
 * Build n-gram index for fast text search
 * @param text The text to index
 * @param nGramSize Size of n-grams
 * @param startPosition Start indexing from this position (default: 0)
 * @returns Map of n-grams to their positions
 */
export function buildNGramIndex(
	text: string,
	nGramSize: number,
	startPosition: number = 0
): Map<string, number[]> {
	const index = new Map<string, number[]>();

	for (let i = startPosition; i < text.length - nGramSize + 1; i++) {
		const gram = text.slice(i, i + nGramSize);
		if (!index.has(gram)) {
			index.set(gram, []);
		}
		const positions = index.get(gram);
		if (positions) {
			positions.push(i);
		}
	}

	return index;
}

/**
 * Find potential match positions using n-gram index
 * @param candidateText Text to search for
 * @param nGramIndex Pre-built n-gram index
 * @param nGramSize Size of n-grams used in index
 * @param minPosition Minimum position to consider
 * @returns Array of potential match regions
 */
export function findPotentialMatches(
	candidateText: string,
	nGramIndex: Map<string, number[]>,
	nGramSize: number,
	minPosition: number = 0
): Array<{position: number, endPosition: number, score: number}> {
	// Extract n-grams from candidate with overlap for better coverage
	const candidateNGrams = new Set<string>();
	const step = Math.max(1, Math.floor(nGramSize / 2));

	for (let i = 0; i <= candidateText.length - nGramSize; i += step) {
		candidateNGrams.add(candidateText.slice(i, i + nGramSize));
	}


	// Find positions that share n-grams
	const positionScores = new Map<number, number>();
	for (const gram of candidateNGrams) {
		const positions = nGramIndex.get(gram);
		if (positions) {
			for (const pos of positions) {
					if (pos >= minPosition) {
						positionScores.set(pos, (positionScores.get(pos) ?? 0) + 1);
					}
				}
			}
		}


	// Convert to array and sort by score
	const scoredPositions = Array.from(positionScores.entries())
		.map(([pos, score]) => ({ position: pos, score }))
		.filter(item => item.score >= Math.max(1, candidateNGrams.size * 0.1)) // At least 10% match or 1 n-gram
		.sort((a, b) => b.score - a.score);


	// Group nearby positions to avoid redundant checks
	const groups: Array<{position: number, endPosition: number, score: number}> = [];
	const groupDistance = candidateText.length; // Group within candidate length

	for (const item of scoredPositions) {
		const lastGroup = groups[groups.length - 1];
		if (!lastGroup || item.position - lastGroup.endPosition > groupDistance) {
			groups.push({
				position: item.position,
				endPosition: item.position + candidateText.length * 2, // Search window
				score: item.score
			});
		} else {
			// Extend existing group
			lastGroup.endPosition = Math.max(lastGroup.endPosition, item.position + candidateText.length * 2);
			lastGroup.score = Math.max(lastGroup.score, item.score);
		}
	}

	// Return top candidates
	return groups.slice(0, 10); // Limit to 10 best regions
}

/**
 * Calculate quick similarity using character frequency
 * Very fast but less accurate than n-gram similarity
 * @param text1 First text
 * @param text2 Second text
 * @returns Similarity score between 0 and 1
 */
export function calculateCharFrequencySimilarity(text1: string, text2: string): number {
	const freq1 = new Map<string, number>();
	const freq2 = new Map<string, number>();

	// Count character frequencies
	for (const char of text1) {
		freq1.set(char, (freq1.get(char) ?? 0) + 1);
	}
	for (const char of text2) {
		freq2.set(char, (freq2.get(char) ?? 0) + 1);
	}

	// Calculate similarity
	let common = 0;
	let total = 0;

	for (const [char, count1] of freq1) {
		const count2 = freq2.get(char) ?? 0;
		common += Math.min(count1, count2);
		total += count1;
	}

	for (const [char, count2] of freq2) {
		if (!freq1.has(char)) {
			total += count2;
		}
	}

	return total > 0 ? common / total : 0;
}

/**
 * Get optimal n-gram size based on text length and use case
 * @param textLength Length of text to analyze
 * @param useCase 'overlap' for chunk overlap detection, 'duplicate' for duplicate removal
 * @returns Recommended n-gram size
 */
export function getOptimalNGramSize(textLength: number, useCase: 'overlap' | 'duplicate'): number {
	if (useCase === 'overlap') {
		// For overlap detection, use smaller n-grams for flexibility
		if (textLength < 50) {
			return 2;
		}
		if (textLength < 200) {
			return 3;
		}
		return 4;
	} else {
		// For duplicate detection, use larger n-grams for precision
		if (textLength < 100) {
			return 3;
		}
		if (textLength < 500) {
			return 5;
		}
		return 7;
	}
}

/**
 * Normalize text for similarity comparison
 * Removes spaces, punctuation, and optionally unifies character types
 * @param text Text to normalize
 * @param options Normalization options
 * @returns Normalized text
 */
export function normalizeTextForComparison(
	text: string,
	options: {
		removeSpaces?: boolean;
		removePunctuation?: boolean;
		unifyKana?: boolean;
		toLowerCase?: boolean;
	} = {}
): string {
	const {
		removeSpaces = true,
		removePunctuation = true,
		unifyKana = false,
		toLowerCase = true
	} = options;

	let normalized = text.normalize('NFKC').replace(/\p{Cf}/gu, '');

	// Convert to lowercase for case-insensitive comparison
	if (toLowerCase) {
		normalized = normalized.toLowerCase();
	}

	// Remove punctuation (Japanese and English)
	if (removePunctuation) {
		// Japanese punctuation: 。、！？「」『』（）｛｝［］【】〈〉《》・…ー
		// English punctuation: .,!?"'(){}[]<>:;-_
		// Other common punctuation: curly quotes, long dashes, full-width comma/period
		normalized = normalized.replace(/[。、！？「」『』（）｛｝［］【】〈〉《》・…ー，．：；‐‑‒–—―−.,!?"'’‘“”(){}[\]<>:;_-]/g, '');
	}

	// Remove all spaces (including full-width spaces)
	if (removeSpaces) {
		normalized = normalized.replace(/[\s\u3000]+/g, '');
	}

	// Unify katakana to hiragana (optional, for Japanese text)
	if (unifyKana) {
		normalized = normalized.replace(/[\u30A1-\u30F6]/g, match => {
			// Convert katakana to hiragana
			return String.fromCharCode(match.charCodeAt(0) - 0x60);
		});
	}

	return normalized;
}

/**
 * Calculate normalized n-gram similarity
 * Applies text normalization before calculating similarity
 * @param text1 First text
 * @param text2 Second text
 * @param nGramSize Size of n-grams to use
 * @param normalizationOptions Options for text normalization
 * @returns Similarity score between 0 and 1
 */
export function calculateNormalizedNGramSimilarity(
	text1: string,
	text2: string,
	nGramSize: number = 3,
	normalizationOptions?: Parameters<typeof normalizeTextForComparison>[1]
): number {
	// Normalize both texts
	const normalizedText1 = normalizeTextForComparison(text1, normalizationOptions);
	const normalizedText2 = normalizeTextForComparison(text2, normalizationOptions);

	// Calculate similarity on normalized texts
	return calculateNGramSimilarity(normalizedText1, normalizedText2, nGramSize);
}
