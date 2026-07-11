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

function speakerRank(speaker: Speaker): number {
	return speaker === "me" ? 0 : 1;
}

function label(speaker: Speaker): string {
	return speaker === "me" ? "Me" : "Them";
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
		.map((s) => ({ text: s.text.trim(), start: s.start, end: s.end }))
		.filter((s) => s.text.length > 0)
		.sort((a, b) => a.start - b.start || a.end - b.end);

	const deduped: DiarSegment[] = [];
	for (const seg of sorted) {
		const prev = deduped[deduped.length - 1];
		const isDuplicate = prev !== undefined && prev.text === seg.text && seg.start < prev.end;
		if (!isDuplicate) {
			deduped.push(seg);
		}
	}

	if (windows === undefined) {
		return deduped;
	}
	// Whisper hallucinates filler ("thank you", "bye") over silence, and the mic
	// stream is mostly silence in a normal meeting (you speak a fraction of the
	// time). Anything that doesn't land in a detected speech window of its own
	// stream is almost certainly one of those ghosts, so drop it. An empty
	// window list means the recorder found no speech on this stream, so every
	// segment is treated as a ghost.
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
		(a, b) => a.seg.start - b.seg.start || speakerRank(a.speaker) - speakerRank(b.speaker)
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

	return lines.map((line) => `${label(line.speaker)}: ${line.text}`).join("\n");
}
