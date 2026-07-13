/**
 * Pure me-vs-them transcript merge. No Obsidian imports so it stays fully unit
 * testable. The recorder writes two mono streams per meeting: the mic ("me")
 * and system audio ("them", i.e. everyone else). Each stream is transcribed on
 * its own but against a shared clock, so we can interleave their timestamped
 * segments back into one speaker-labelled transcript.
 */

import { collapseRepetitions, isHallucinationPhrase } from "./hallucination";

export interface DiarSegment {
	text: string;
	start: number;
	end: number;
	/**
	 * Whisper `verbose_json` per-segment confidence signals, when the endpoint
	 * returns them. Used to drop silence hallucinations before merging. All
	 * optional — endpoints that omit them simply skip confidence filtering.
	 */
	noSpeechProb?: number;
	avgLogprob?: number;
	compressionRatio?: number;
}

/**
 * Speech windows (seconds) detected per stream by the recorder. Optional: when
 * absent or empty we keep every segment of that stream.
 */
export interface SpeechWindows {
	me: Array<[number, number]>;
	them: Array<[number, number]>;
}

/**
 * Combine two window sources per stream: keep `primary`'s windows for a stream
 * when it detected any speech, else fall back to `fallback`'s for that stream.
 * Lets local WebRTC VAD and the recorder's RMS gate cover for each other when
 * one under-detects a stream (e.g. a quiet mic the RMS gate found but VAD
 * didn't, or vice versa). Returns undefined only when both are undefined; an
 * empty result for a stream still means "keep all" downstream.
 */
export function preferWindows(
	primary?: SpeechWindows,
	fallback?: SpeechWindows
): SpeechWindows | undefined {
	if (!primary) return fallback;
	if (!fallback) return primary;
	return {
		me: primary.me.length > 0 ? primary.me : fallback.me,
		them: primary.them.length > 0 ? primary.them : fallback.them,
	};
}

type Speaker = "me" | "them";

/** Inclusive: two ranges that merely touch at an endpoint still count. */
function rangesTouch(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
	return aStart <= bEnd && bStart <= aEnd;
}

function withinAnyWindow(seg: DiarSegment, windows: Array<[number, number]>): boolean {
	return windows.some(([ws, we]) => rangesTouch(seg.start, seg.end, ws, we));
}

// Whisper's own silence/degenerate-output thresholds (the defaults its decoder
// uses to blank a segment): a segment is treated as no-speech when the model is
// confident the audio is silence (no_speech_prob high) AND the text it emitted
// anyway is low-probability (avg_logprob low). compression_ratio catches the
// other failure mode — looping/repetitive gibberish over noise.
const NO_SPEECH_PROB_MAX = 0.6;
const AVG_LOGPROB_MIN = -1.0;
const COMPRESSION_RATIO_MAX = 2.4;

/**
 * True when a segment's confidence signals mark it as a silence hallucination.
 * Requires the endpoint to have returned the signals; when they're absent this
 * is a no-op (the phrase filter and speech-window filter still apply).
 */
function isLowConfidenceHallucination(seg: DiarSegment): boolean {
	if (
		seg.noSpeechProb !== undefined &&
		seg.avgLogprob !== undefined &&
		seg.noSpeechProb > NO_SPEECH_PROB_MAX &&
		seg.avgLogprob < AVG_LOGPROB_MIN
	) {
		return true;
	}
	// A runaway compression ratio only counts as a hallucination when the text
	// is ALSO low-probability. Genuine repetition ("yes yes yes", counting) has
	// a high compression ratio too but a healthy avg_logprob, so requiring both
	// avoids erasing real repetitive speech.
	if (
		seg.compressionRatio !== undefined &&
		seg.compressionRatio > COMPRESSION_RATIO_MAX &&
		seg.avgLogprob !== undefined &&
		seg.avgLogprob < AVG_LOGPROB_MIN
	) {
		return true;
	}
	return false;
}

// One table for the me-first pairing: rank orders a start-time tie (me before
// them) and label is what we print. Both used to live in their own one-line
// mappers encoding the same thing.
const SPEAKERS: Record<Speaker, { rank: number; label: string }> = {
	me: { rank: 0, label: "Me" },
	them: { rank: 1, label: "Them" },
};

// Cross-talk (bleed) de-dup thresholds. Two segments are the "same" utterance
// echoed across streams when they overlap in time AND their word sets are
// mostly shared. Kept conservative so genuine simultaneous-but-different speech
// (real cross-talk) survives.
const CROSSTALK_SIMILARITY = 0.6;
const CROSSTALK_MIN_TOKENS = 3;
// A real bleed echo sits almost on top of its source in time. Requiring the mic
// segment to be mostly covered by the them segment avoids dropping genuine
// simultaneous-but-distinct speech that only briefly overlaps.
const CROSSTALK_MIN_OVERLAP = 0.5;

/** Words only, lowercased, punctuation stripped — for fuzzy cross-stream matching. */
function tokenize(text: string): string[] {
	const norm = text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, "")
		.replace(/\s+/g, " ")
		.trim();
	return norm.length === 0 ? [] : norm.split(" ");
}

/** Jaccard overlap of the two segments' word sets (0 when either is empty). */
function textSimilarity(a: string, b: string): number {
	const ta = new Set(tokenize(a));
	const tb = new Set(tokenize(b));
	if (ta.size === 0 || tb.size === 0) return 0;
	let intersection = 0;
	for (const t of ta) {
		if (tb.has(t)) intersection++;
	}
	const union = ta.size + tb.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/** Fraction of `a`'s duration that falls within `b` (0 when they don't overlap). */
function overlapFraction(a: DiarSegment, b: DiarSegment): number {
	const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
	if (overlap <= 0) return 0;
	const duration = a.end - a.start;
	return duration <= 0 ? 0 : overlap / duration;
}

/**
 * Drop mic ("me") segments that are really system audio bleeding into the mic:
 * when the speakers play the remote participants, that audio leaks back into
 * the mic and Whisper transcribes it a second time on the "me" stream. The
 * echoed copy overlaps its "them" twin in time and repeats most of its words,
 * so we drop the "me" copy and keep "them" (the true source). With headphones
 * there is no bleed and this never fires. Short segments are kept — too little
 * text to tell an echo from a genuine "yeah"/"right" over the other speaker.
 */
function dropCrossTalk(meSegs: DiarSegment[], themSegs: DiarSegment[]): DiarSegment[] {
	if (themSegs.length === 0) return meSegs;
	return meSegs.filter((me) => {
		if (tokenize(me.text).length < CROSSTALK_MIN_TOKENS) return true;
		const isEcho = themSegs.some(
			(them) =>
				overlapFraction(me, them) >= CROSSTALK_MIN_OVERLAP &&
				textSimilarity(me.text, them.text) >= CROSSTALK_SIMILARITY
		);
		return !isEcho;
	});
}

/**
 * Sort a single stream by start, drop the duplicate a segment picks up from an
 * overlapping chunk boundary, then (when we have them) drop segments that fall
 * outside the stream's own speech windows.
 *
 * The whisper engine chunks with overlap and its WorkflowResult.segments is a
 * plain concat of every chunk's segments, so a segment that lands in the shared
 * overlap region shows up twice. The duplicate check wants real time overlap
 * (strict <), not just touching: back-to-back segments in one chunk touch at
 * the boundary and can legitimately repeat a word, whereas a chunk-overlap
 * duplicate sits on top of its twin with the same text.
 */
function prepareStream(segments: DiarSegment[], windows?: Array<[number, number]>): DiarSegment[] {
	const sorted = segments
		// Collapse decoder repetition loops per segment up front ("all right,
		// all right, …", a clause duplicated verbatim) so the shared-clock merge,
		// the overlap-dedup below, and the window filter all see cleaned text.
		.map((s) => ({ ...s, text: collapseRepetitions(s.text.trim()) }))
		.filter((s) => s.text.length > 0)
		// Drop silence hallucinations before they reach the shared clock: the
		// endpoint's own confidence signals (when present) and a whole-segment
		// stock-phrase match ("Thanks for watching.", "[Music]", …). Both are
		// per-segment and conservative, so a real utterance survives.
		.filter((s) => !isLowConfidenceHallucination(s))
		.filter((s) => !isHallucinationPhrase(s.text))
		.sort((a, b) => a.start - b.start || a.end - b.end);

	const deduped: DiarSegment[] = [];
	for (const seg of sorted) {
		// A chunk-overlap duplicate sits on top of an already-kept segment with
		// the same text. Scan back over recent kept segments while they still
		// overlap this one in time; since the list is sorted by start, stop once
		// a kept segment ends at or before this one starts. Comparing only the
		// immediately previous kept segment missed a duplicate pair split by an
		// unrelated segment landing between them, e.g. A, B, A'.
		let isDuplicate = false;
		for (let i = deduped.length - 1; i >= 0; i--) {
			const kept = deduped[i];
			if (kept === undefined || kept.end <= seg.start) {
				break;
			}
			if (kept.text === seg.text) {
				isDuplicate = true;
				break;
			}
		}
		if (!isDuplicate) {
			deduped.push(seg);
		}
	}

	// Filter only against a non-empty window list. Whisper hallucinates filler
	// ("thank you", "bye") over silence, and in a normal meeting the mic is
	// mostly silence, so a segment outside every detected speech window is almost
	// certainly one of those ghosts, drop it.
	//
	// An EMPTY window list is the opposite signal: the recorder's speech gate
	// (a fixed absolute RMS threshold) found nothing, but Whisper still produced
	// transcribable segments. Quiet speech at ~-40dBFS sits under that gate while
	// Whisper transcribes it fine, so filtering here would silently erase a
	// quiet-but-real speaker. Whisper finding speech is stronger evidence than
	// our crude gate, so an empty list means keep everything.
	if (windows === undefined || windows.length === 0) {
		return deduped;
	}
	return deduped.filter((seg) => withinAnyWindow(seg, windows));
}

/**
 * Merge the two per-stream segment lists into a single speaker-labelled
 * transcript. Empty inputs produce sensible output: one stream empty means
 * every line is labelled from the other; both empty yields "".
 */
export function mergeDiarized(me: DiarSegment[], them: DiarSegment[], windows?: SpeechWindows): string {
	const themSegs = prepareStream(them, windows?.them);
	// Drop system-audio bleed from the mic stream before interleaving, so a
	// remote participant's line isn't attributed to both "Them" and "Me".
	const meSegs = dropCrossTalk(prepareStream(me, windows?.me), themSegs);

	const labeled: Array<{ speaker: Speaker; seg: DiarSegment }> = [
		...meSegs.map((seg) => ({ speaker: "me" as const, seg })),
		...themSegs.map((seg) => ({ speaker: "them" as const, seg })),
	];
	// Interleave by time. On a tie "me" goes first, so the order is stable.
	labeled.sort(
		(a, b) => a.seg.start - b.seg.start || SPEAKERS[a.speaker].rank - SPEAKERS[b.speaker].rank
	);

	const lines: Array<{ speaker: Speaker; text: string }> = [];
	for (const { speaker, seg } of labeled) {
		const last = lines[lines.length - 1];
		if (last && last.speaker === speaker) {
			// Same speaker keeps talking; fold it into the current line.
			last.text += " " + seg.text;
		} else {
			lines.push({ speaker, text: seg.text });
		}
	}

	// Catch a hallucination Whisper split across adjacent segments ("Thanks" +
	// "for watching") that each slipped the per-segment filter but reconstitute
	// into a stock phrase once folded onto one speaker line. A fully-silent
	// stream is the common case here (its whole line is the split phrase).
	return lines
		.filter((line) => !isHallucinationPhrase(line.text))
		.map((line) => `${SPEAKERS[line.speaker].label}: ${line.text}`)
		.join("\n");
}
