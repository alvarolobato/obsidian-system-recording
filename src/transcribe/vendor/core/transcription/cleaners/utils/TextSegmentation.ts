type SupportedLanguage = 'ja' | 'en' | 'zh' | 'ko';

type SegmenterGranularity = 'grapheme' | 'sentence';

type SegmenterLike = {
	segment: (input: string) => Iterable<{ segment: string }>;
};

type SegmenterConstructorLike = new (
	locales: string | string[] | undefined,
	options: { granularity: SegmenterGranularity }
) => SegmenterLike;

let cachedGraphemeSegmenter: SegmenterLike | null | undefined;
let cachedDefaultSentenceSegmenter: SegmenterLike | null | undefined;
const cachedSentenceSegmenters = new Map<SupportedLanguage, SegmenterLike | null>();

function getSupportedLanguage(language: string | undefined): SupportedLanguage | undefined {
	if (language === 'ja' || language === 'en' || language === 'zh' || language === 'ko') {
		return language;
	}
	return undefined;
}

function getSegmenterConstructor(): SegmenterConstructorLike | null {
	const constructor = (Intl as unknown as { Segmenter?: unknown }).Segmenter;
	if (typeof constructor !== 'function') {
		return null;
	}
	return constructor as SegmenterConstructorLike;
}

function getGraphemeSegmenter(): SegmenterLike | null {
	if (cachedGraphemeSegmenter !== undefined) {
		return cachedGraphemeSegmenter;
	}

	const Segmenter = getSegmenterConstructor();
	const segmenter = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;

	cachedGraphemeSegmenter = segmenter;
	return segmenter;
}

function getSentenceSegmenter(language: string | undefined): SegmenterLike | null {
	const supported = getSupportedLanguage(language);
	if (!supported) {
		return null;
	}

	const cached = cachedSentenceSegmenters.get(supported);
	if (cached !== undefined) {
		return cached;
	}

	const Segmenter = getSegmenterConstructor();
	const segmenter = Segmenter ? new Segmenter(supported, { granularity: 'sentence' }) : null;

	cachedSentenceSegmenters.set(supported, segmenter);
	return segmenter;
}

function getDefaultSentenceSegmenter(): SegmenterLike | null {
	if (cachedDefaultSentenceSegmenter !== undefined) {
		return cachedDefaultSentenceSegmenter;
	}

	const Segmenter = getSegmenterConstructor();
	const segmenter = Segmenter ? new Segmenter(undefined, { granularity: 'sentence' }) : null;
	cachedDefaultSentenceSegmenter = segmenter;
	return segmenter;
}

export function sliceHeadGraphemes(text: string, graphemeCount: number): string {
	if (!text || graphemeCount <= 0) {
		return '';
	}

	const segmenter = getGraphemeSegmenter();
	if (!segmenter) {
		return Array.from(text).slice(0, graphemeCount).join('');
	}

	let out = '';
	let count = 0;
	for (const item of segmenter.segment(text)) {
		out += item.segment;
		count++;
		if (count >= graphemeCount) {
			break;
		}
	}

	return out;
}

function splitSentencesFallback(text: string): string[] {
	const segments: string[] = [];
	const regex = /[^。.!?！？?]*[。.!?！？?]+\s*/g;

	let lastIndex = 0;
	for (const match of text.matchAll(regex)) {
		const segment = match[0];
		const index = match.index;
		lastIndex = Math.max(lastIndex, index + segment.length);
		if (segment.trim()) {
			segments.push(segment);
		}
	}

	const rest = text.slice(lastIndex);
	if (rest.trim()) {
		segments.push(rest);
	}

	return segments;
}

function mergeEnglishFallbackFragments(segments: string[]): string[] {
	const merged: string[] = [];

	for (let i = 0; i < segments.length; i++) {
		let current = segments[i] ?? '';
		for (;;) {
			const next = segments[i + 1];
			if (!next) {
				break;
			}

			const currentTrimmed = current.trimEnd();
			const nextTrimmed = next.trimStart();
			if (!nextTrimmed) {
				break;
			}

			const isDecimal = /\d\.\s*$/.test(currentTrimmed) && /^\d/.test(nextTrimmed);
			const isMultiInitial = /\b(?:[A-Z]\.){2,}\s*$/u.test(currentTrimmed);
			const isCommonAbbrev = /\b(?:e\.g|i\.e|etc|vs|mr|ms|mrs|dr|prof|sr|jr|st)\.\s*$/i.test(currentTrimmed);
			const isPairedInitial = /\b[A-Z]\.\s*$/.test(currentTrimmed) && /^[A-Z]\./.test(nextTrimmed);

			if (!isDecimal && !isMultiInitial && !isCommonAbbrev && !isPairedInitial) {
				break;
			}

			current += next;
			i++;
		}
		merged.push(current);
	}

	return merged;
}

export function splitIntoSentences(text: string, language: string): string[] {
	const segmenter = getSentenceSegmenter(language) ?? getDefaultSentenceSegmenter();
	if (segmenter) {
		const segments: string[] = [];
		for (const item of segmenter.segment(text)) {
			const segment = item.segment;
			if (segment.trim()) {
				segments.push(segment);
			}
		}
		return segments.length > 0 ? segments : [text];
	}

	const fallback = splitSentencesFallback(text);
	if (language === 'en' || language === 'auto') {
		return mergeEnglishFallbackFragments(fallback);
	}
	return fallback;
}
