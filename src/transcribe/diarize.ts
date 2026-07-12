/**
 * Pure me-vs-them transcript merge. No Obsidian imports so it stays fully unit
 * testable. The recorder writes two mono streams per meeting: the mic ("me")
 * and system audio ("them", i.e. everyone else). Each stream is transcribed on
 * its own but against a shared clock, so we can interleave their timestamped
 * segments back into one speaker-labelled transcript.
 */

export interface DiarSegment {
	text: string;
	start: number;
	end: number;
}

/**
 * Speech windows (seconds) detected per stream by the recorder. Optional: when
 * absent or empty we keep every segment of that stream.
 */
export interface SpeechWindows {
	me: Array<[number, number]>;
	them: Array<[number, number]>;
}

type Speaker = "me" | "them";

/** Inclusive: two ranges that merely touch at an endpoint still count. */
function rangesTouch(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
	return aStart <= bEnd && bStart <= aEnd;
}

function withinAnyWindow(seg: DiarSegment, windows: Array<[number, number]>): boolean {
	return windows.some(([ws, we]) => rangesTouch(seg.start, seg.end, ws, we));
}

// One table for the me-first pairing: rank orders a start-time tie (me before
// them) and label is what we print. Both used to live in their own one-line
// mappers encoding the same thing.
const SPEAKERS: Record<Speaker, { rank: number; label: string }> = {
	me: { rank: 0, label: "Me" },
	them: { rank: 1, label: "Them" },
};

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
		.map((s) => ({ text: s.text.trim(), start: s.start, end: s.end }))
		.filter((s) => s.text.length > 0)
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
	const meSegs = prepareStream(me, windows?.me);
	const themSegs = prepareStream(them, windows?.them);

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

	return lines.map((line) => `${SPEAKERS[line.speaker].label}: ${line.text}`).join("\n");
}
