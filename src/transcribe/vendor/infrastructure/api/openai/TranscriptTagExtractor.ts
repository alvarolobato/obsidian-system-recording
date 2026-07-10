export type TranscriptTagExtractionMode = 'none' | 'full' | 'openOnly' | 'closeOnly';

export interface TranscriptTagExtractionResult {
	extractedText: string;
	mode: TranscriptTagExtractionMode;
	hadTranscriptTags: boolean;
}

const TRANSCRIPT_TAG_OPEN = '<TRANSCRIPT>';
const TRANSCRIPT_TAG_CLOSE = '</TRANSCRIPT>';

function indexOfCaseInsensitive(haystack: string, needle: string): number {
	return haystack.toLowerCase().indexOf(needle.toLowerCase());
}

/**
 * Extract transcript content from <TRANSCRIPT> wrapper tags.
 *
 * The GPT-4o transcribe prompt requests this format, but the model may:
 * - omit the closing tag
 * - add leading text before the opening tag
 * - include only the closing tag
 *
 * To keep chunk merging stable and avoid leaking prompt artifacts into the final note,
 * we apply a conservative extraction strategy near the beginning/end of the response.
 */
export function extractTranscriptFromTagWrapper(rawText: string): TranscriptTagExtractionResult {
	const original = rawText;
	const hadTranscriptTags =
		indexOfCaseInsensitive(original, TRANSCRIPT_TAG_OPEN) >= 0 ||
		indexOfCaseInsensitive(original, TRANSCRIPT_TAG_CLOSE) >= 0;

	const fullMatch = original.match(/<TRANSCRIPT>([\s\S]*?)<\/TRANSCRIPT>/i);
	if (fullMatch) {
		const extracted = fullMatch[1];
		if (extracted !== undefined) {
			return { extractedText: extracted.trim(), mode: 'full', hadTranscriptTags: true };
		}
	}

	const MAX_LEADING_TAG_SEARCH = 200;
	const openIndex = indexOfCaseInsensitive(original, TRANSCRIPT_TAG_OPEN);
	if (openIndex >= 0 && openIndex <= MAX_LEADING_TAG_SEARCH) {
		const afterOpen = original.slice(openIndex + TRANSCRIPT_TAG_OPEN.length);
		const closeIndex = indexOfCaseInsensitive(afterOpen, TRANSCRIPT_TAG_CLOSE);
		const inside = closeIndex >= 0 ? afterOpen.slice(0, closeIndex) : afterOpen;
		return {
			extractedText: inside.trim(),
			mode: closeIndex >= 0 ? 'full' : 'openOnly',
			hadTranscriptTags: true
		};
	}

	const MAX_TRAILING_TAG_SEARCH = 200;
	const closeIndex = indexOfCaseInsensitive(original, TRANSCRIPT_TAG_CLOSE);
	if (closeIndex >= 0 && original.length - closeIndex <= MAX_TRAILING_TAG_SEARCH) {
		return { extractedText: original.slice(0, closeIndex).trim(), mode: 'closeOnly', hadTranscriptTags: true };
	}

	return { extractedText: original.trim(), mode: 'none', hadTranscriptTags };
}
