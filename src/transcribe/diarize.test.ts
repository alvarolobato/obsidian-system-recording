import { describe, expect, it } from "vitest";
import {
	mergeDiarized,
	preferWindows,
	pregateSources,
	type DiarSegment,
	type SpeechWindows,
} from "./diarize";

function seg(text: string, start: number, end: number): DiarSegment {
	return { text, start, end };
}

describe("mergeDiarized", () => {
	it("returns empty string when both streams are empty", () => {
		expect(mergeDiarized([], [])).toBe("");
	});

	it("labels every line from the only non-empty stream", () => {
		const me = [seg("hi there", 0, 1), seg("how are you", 5, 6)];
		// Consecutive same-speaker segments collapse into one line.
		expect(mergeDiarized(me, [])).toBe("Me: hi there how are you");
	});

	it("labels a them-only stream", () => {
		const them = [seg("welcome everyone", 0, 2)];
		expect(mergeDiarized([], them)).toBe("Them: welcome everyone");
	});

	it("interleaves the two streams by start time", () => {
		const me = [seg("question", 3, 4)];
		const them = [seg("intro", 0, 1), seg("answer", 6, 7)];
		expect(mergeDiarized(me, them)).toBe(
			["Them: intro", "Me: question", "Them: answer"].join("\n")
		);
	});

	describe("cross-talk (system-audio bleed) de-dup", () => {
		it("drops a mic echo of an overlapping, near-identical them segment", () => {
			// Speakers play the remote participant; that audio leaks into the mic
			// and Whisper transcribes it again on the me stream at the same time.
			const them = [seg("let us review the quarterly numbers", 10, 13)];
			const me = [seg("let us review the quarterly numbers", 10, 13)];
			expect(mergeDiarized(me, them)).toBe(
				"Them: let us review the quarterly numbers"
			);
		});

		it("drops the echo even with minor transcription differences", () => {
			// Whisper adds a trailing word on the cleaner them stream; the word
			// sets still overlap well above threshold.
			const them = [seg("let us review the quarterly numbers now", 10, 13)];
			const me = [seg("let us review the quarterly numbers", 10, 13)];
			expect(mergeDiarized(me, them)).toBe(
				"Them: let us review the quarterly numbers now"
			);
		});

		it("keeps a short mic reaction over the other speaker", () => {
			// Too few words to distinguish an echo from a genuine backchannel.
			const them = [seg("and so the plan is to ship on friday", 10, 14)];
			const me = [seg("yeah exactly", 11, 12)];
			expect(mergeDiarized(me, them)).toBe(
				["Them: and so the plan is to ship on friday", "Me: yeah exactly"].join(
					"\n"
				)
			);
		});

		it("keeps genuinely different simultaneous speech", () => {
			// Them starts slightly earlier so ordering is deterministic.
			const them = [seg("i think we should postpone the launch", 10, 13)];
			const me = [seg("no we already promised the customer", 10.5, 13)];
			expect(mergeDiarized(me, them)).toBe(
				[
					"Them: i think we should postpone the launch",
					"Me: no we already promised the customer",
				].join("\n")
			);
		});

		it("keeps an identical me line that does not overlap in time", () => {
			// Same words but at a different moment — a real repeated phrase, not bleed.
			const them = [seg("thanks for the update", 5, 7)];
			const me = [seg("thanks for the update", 30, 32)];
			expect(mergeDiarized(me, them)).toBe(
				["Them: thanks for the update", "Me: thanks for the update"].join("\n")
			);
		});

		it("keeps similar speech that only briefly overlaps (not a full echo)", () => {
			// High word overlap (Jaccard 0.75) but the mic segment only clips the
			// tail of the them segment (~11% of its duration), so it's kept — a
			// real echo would sit almost entirely on top of its source.
			const them = [seg("we should ship the release on friday", 10, 16)];
			const me = [seg("we should ship the release on monday", 15.5, 20)];
			expect(mergeDiarized(me, them)).toBe(
				[
					"Them: we should ship the release on friday",
					"Me: we should ship the release on monday",
				].join("\n")
			);
		});
	});

	describe("preferWindows", () => {
		const local: SpeechWindows = { me: [[1, 2]], them: [[3, 4]] };
		const rms: SpeechWindows = { me: [[5, 6]], them: [[7, 8]] };

		it("returns the other when one is undefined", () => {
			expect(preferWindows(undefined, rms)).toBe(rms);
			expect(preferWindows(local, undefined)).toBe(local);
			expect(preferWindows(undefined, undefined)).toBeUndefined();
		});

		it("keeps primary windows for a stream that detected speech", () => {
			expect(preferWindows(local, rms)).toEqual({
				me: [[1, 2]],
				them: [[3, 4]],
			});
		});

		it("falls back per stream when primary found no speech there", () => {
			const primary: SpeechWindows = { me: [], them: [[3, 4]] };
			expect(preferWindows(primary, rms)).toEqual({
				me: [[5, 6]], // fell back to RMS for the empty mic stream
				them: [[3, 4]], // kept local for the stream that had speech
			});
		});
	});

	describe("pregateSources", () => {
		const vad: SpeechWindows = { me: [[1, 2]], them: [[3, 4]] };
		const rms: SpeechWindows = { me: [[5, 6]], them: [[7, 8]] };

		it("marks a stream VAD detected speech on as 'vad'", () => {
			expect(pregateSources(vad, rms)).toEqual({ me: "vad", them: "vad" });
		});

		it("uses 'rms' only when VAD was unavailable entirely", () => {
			// VAD undefined => it couldn't run at all; RMS is the only signal.
			expect(pregateSources(undefined, rms)).toEqual({ me: "rms", them: "rms" });
		});

		it("refuses to pre-gate a stream VAD ran on but heard nothing", () => {
			// VAD ran (defined) and found zero on 'me' while RMS found some: that's
			// the marginal/quiet stream, so 'me' is 'none' (full pass), not 'rms'.
			const vadZeroMe: SpeechWindows = { me: [], them: [[3, 4]] };
			expect(pregateSources(vadZeroMe, rms)).toEqual({
				me: "none",
				them: "vad",
			});
		});

		it("is 'none' when neither detector has windows for a stream", () => {
			expect(pregateSources(undefined, undefined)).toEqual({
				me: "none",
				them: "none",
			});
			const bothEmpty: SpeechWindows = { me: [], them: [] };
			expect(pregateSources(undefined, bothEmpty)).toEqual({
				me: "none",
				them: "none",
			});
		});

		it("is 'none' for both when VAD ran, heard nothing, but RMS has windows", () => {
			// VAD ran (defined) and found zero on both streams while RMS found some:
			// the whole meeting is marginal, so full passes rather than trusting the
			// crude gate's edges on either stream.
			const vadSilent: SpeechWindows = { me: [], them: [] };
			expect(pregateSources(vadSilent, rms)).toEqual({
				me: "none",
				them: "none",
			});
		});
	});

	it("collapses consecutive segments from the same speaker into one line", () => {
		const me = [seg("one", 0, 1), seg("two", 1, 2), seg("three", 2, 3)];
		const them = [seg("reply", 4, 5)];
		expect(mergeDiarized(me, them)).toBe(
			["Me: one two three", "Them: reply"].join("\n")
		);
	});

	it("puts 'me' first when two segments share a start time", () => {
		const me = [seg("mine", 2, 3)];
		const them = [seg("theirs", 2, 4)];
		expect(mergeDiarized(me, them)).toBe(["Me: mine", "Them: theirs"].join("\n"));
	});

	it("trims whitespace on segment texts", () => {
		const me = [seg("  spaced out  ", 0, 1)];
		expect(mergeDiarized(me, [])).toBe("Me: spaced out");
	});

	it("drops segments whose text is empty after trimming", () => {
		const me = [seg("   ", 0, 1), seg("real", 2, 3)];
		expect(mergeDiarized(me, [])).toBe("Me: real");
	});

	describe("per-stream dedupe of chunk-overlap duplicates", () => {
		it("drops an identical segment that overlaps its twin in time", () => {
			// Same text landing on top of itself from an overlapping chunk.
			const me = [seg("hello world", 10, 12), seg("hello world", 10, 12)];
			expect(mergeDiarized(me, [])).toBe("Me: hello world");
		});

		it("drops a near-identical duplicate with slightly shifted times", () => {
			const me = [seg("hello world", 10, 12), seg("hello world", 10.1, 12.1)];
			expect(mergeDiarized(me, [])).toBe("Me: hello world");
		});

		it("keeps repeated text that only touches at the boundary (no real overlap)", () => {
			// Back-to-back "yeah" said twice is legitimate, not a chunk duplicate.
			const me = [seg("yeah", 0, 1), seg("yeah", 1, 2)];
			expect(mergeDiarized(me, [])).toBe("Me: yeah yeah");
		});

		it("keeps overlapping segments when the text differs", () => {
			const me = [seg("first thing", 0, 2), seg("second thing", 1, 3)];
			expect(mergeDiarized(me, [])).toBe("Me: first thing second thing");
		});

		it("drops a duplicate separated from its twin by another segment (A, B, A')", () => {
			// A' overlaps A but a different segment B was kept between them. A check
			// against only the previous kept segment would compare A' to B, miss the
			// match, and keep the duplicate.
			const me = [
				seg("alpha", 10.0, 12.0),
				seg("beta", 11.8, 14.0),
				seg("alpha", 11.9, 13.9),
			];
			expect(mergeDiarized(me, [])).toBe("Me: alpha beta");
		});
	});

	describe("cross-segment decoder loops", () => {
		it("collapses a 5+ word clause repeated across consecutive segments to one", () => {
			// The real bug: Whisper's decoder loops on a near-silent channel and
			// emits the same clause as many back-to-back segments. Per-segment
			// collapse can't see across the seam, so without this it stays ~15 lines.
			const me = [
				seg("And then you take two small bananas", 10, 12),
				seg("And then you take two small bananas", 13, 15),
				seg("And then you take two small bananas", 16, 18),
				seg("And then you take two small bananas", 19, 21),
			];
			expect(mergeDiarized(me, [])).toBe("Me: And then you take two small bananas");
		});

		it("keeps a short phrase repeated only twice (below the 3× threshold)", () => {
			const me = [seg("all right", 0, 1), seg("all right", 2, 3)];
			expect(mergeDiarized(me, [])).toBe("Me: all right all right");
		});

		it("collapses a 2–4 word phrase repeated 3× to one", () => {
			const me = [seg("all right", 0, 1), seg("all right", 2, 3), seg("all right", 4, 5)];
			expect(mergeDiarized(me, [])).toBe("Me: all right");
		});

		it("collapses a single word repeated 4×+ to two", () => {
			const me = [
				seg("okay", 0, 1),
				seg("okay", 2, 3),
				seg("okay", 4, 5),
				seg("okay", 6, 7),
				seg("okay", 8, 9),
			];
			expect(mergeDiarized(me, [])).toBe("Me: okay okay");
		});

		it("leaves a repeat that is NOT consecutive (real speech between) alone", () => {
			const me = [
				seg("two small bananas", 0, 2),
				seg("something else entirely", 3, 5),
				seg("two small bananas", 6, 8),
			];
			expect(mergeDiarized(me, [])).toBe(
				"Me: two small bananas something else entirely two small bananas"
			);
		});

		it("collapses a loop split unevenly across segments once folded onto a line", () => {
			// Neither segment loops enough on its own, and their normalized text
			// differs so the per-run collapse skips them, but the folded line is a
			// single-word loop the folded-line collapseRepetitions trims.
			const me = [seg("go go go", 0, 1), seg("go go", 2, 3)];
			expect(mergeDiarized(me, [])).toBe("Me: go go");
		});

		it("collapses the loop on the looping stream only, not the other speaker", () => {
			const me = [
				seg("yep totally agree with that", 0, 2),
				seg("yep totally agree with that", 3, 5),
			];
			const them = [seg("here is my actual point", 6, 8)];
			expect(mergeDiarized(me, them)).toBe(
				["Me: yep totally agree with that", "Them: here is my actual point"].join("\n")
			);
		});
	});

	describe("speech-window filtering", () => {
		it("keeps a segment overlapping a window and drops one outside every window", () => {
			const me = [seg("real speech", 10, 12), seg("ghost line", 40, 41)];
			const windows: SpeechWindows = { me: [[9, 13]], them: [] };
			expect(mergeDiarized(me, [], windows)).toBe("Me: real speech");
		});

		it("filters each stream against its own windows only", () => {
			const me = [seg("me speech", 0, 2), seg("me ghost", 20, 21)];
			const them = [seg("them speech", 30, 32), seg("them ghost", 0, 1)];
			const windows: SpeechWindows = { me: [[0, 3]], them: [[29, 33]] };
			expect(mergeDiarized(me, them, windows)).toBe(
				["Me: me speech", "Them: them speech"].join("\n")
			);
		});

		it("keeps a segment that only touches a window edge (inclusive)", () => {
			// Segment ends exactly where the window starts.
			const me = [seg("edge touch", 8, 10)];
			const windows: SpeechWindows = { me: [[10, 15]], them: [] };
			expect(mergeDiarized(me, [], windows)).toBe("Me: edge touch");
		});

		it("keeps every segment when the stream's window list is empty", () => {
			const me = [seg("anything", 0, 2)];
			const windows: SpeechWindows = { me: [], them: [[0, 5]] };
			// An empty window array means the recorder's RMS gate found no speech,
			// but Whisper transcribed segments anyway. Whisper is the stronger
			// signal, so we keep them rather than filter against nothing.
			expect(mergeDiarized(me, [], windows)).toBe("Me: anything");
		});

		it("keeps a quiet-mic speaker the recorder's gate missed", () => {
			// Quiet speech (~-40dBFS) sits under the recorder's fixed RMS gate, so
			// the mic window list comes back empty even though the speaker is real
			// and Whisper transcribed them. This must never silently erase them.
			const me = [seg("i can barely be heard", 5, 8)];
			const them = [seg("loud and clear", 0, 2)];
			const windows: SpeechWindows = { me: [], them: [[0, 3]] };
			expect(mergeDiarized(me, them, windows)).toBe(
				["Them: loud and clear", "Me: i can barely be heard"].join("\n")
			);
		});

		it("keeps all segments when windows are omitted", () => {
			const me = [seg("kept", 0, 1), seg("also kept", 100, 101)];
			expect(mergeDiarized(me, [])).toBe("Me: kept also kept");
		});
	});

	describe("silence-hallucination filtering", () => {
		it("drops a whole-segment stock phrase before merging", () => {
			const me = [seg("real point", 0, 2), seg("Thanks for watching!", 5, 6)];
			expect(mergeDiarized(me, [])).toBe("Me: real point");
		});

		it("drops a bracketed non-speech token", () => {
			const them = [seg("[Music]", 0, 4), seg("welcome all", 5, 7)];
			expect(mergeDiarized([], them)).toBe("Them: welcome all");
		});

		it("drops a low-confidence silence segment via Whisper signals", () => {
			// no_speech_prob high AND avg_logprob low => Whisper's own silence rule.
			const me: DiarSegment[] = [
				{ text: "you", start: 0, end: 1, noSpeechProb: 0.9, avgLogprob: -1.5 },
				{ text: "on the topic of billing", start: 5, end: 8, noSpeechProb: 0.02, avgLogprob: -0.2 },
			];
			expect(mergeDiarized(me, [])).toBe("Me: on the topic of billing");
		});

		it("keeps a real segment even with high no_speech_prob when avg_logprob is healthy", () => {
			const me: DiarSegment[] = [
				{ text: "quick point here", start: 0, end: 2, noSpeechProb: 0.9, avgLogprob: -0.3 },
			];
			expect(mergeDiarized(me, [])).toBe("Me: quick point here");
		});

		it("drops looping gibberish (high compression ratio AND low logprob)", () => {
			const me: DiarSegment[] = [
				{ text: "la la la la la la", start: 0, end: 3, compressionRatio: 3.1, avgLogprob: -1.4 },
				{ text: "actual content", start: 5, end: 7 },
			];
			expect(mergeDiarized(me, [])).toBe("Me: actual content");
		});

		it("does not DROP a confident high-compression segment, but collapses the loop", () => {
			// A healthy logprob keeps isLowConfidenceHallucination from dropping
			// the segment — but the text-level collapser still trims a runaway
			// single-word loop to two (endpoint gives no way to tell it from a
			// decoder loop, and in practice it always is one).
			const me: DiarSegment[] = [
				{ text: "yes yes yes yes", start: 0, end: 2, compressionRatio: 3.0, avgLogprob: -0.2 },
			];
			expect(mergeDiarized(me, [])).toBe("Me: yes yes");
		});

		it("collapses a high-compression loop even when no avg_logprob is present", () => {
			// Compression alone can't DROP the segment (endpoints that omit
			// avg_logprob must not lose real speech), but the collapser trims the
			// loop — the gateway strips confidence signals, so this is the only
			// backstop against "no no no no no …".
			const me: DiarSegment[] = [
				{ text: "no no no no no", start: 0, end: 2, compressionRatio: 3.5 },
			];
			expect(mergeDiarized(me, [])).toBe("Me: no no");
		});

		it("drops a stock phrase Whisper split across adjacent segments", () => {
			// Neither half is a stock phrase alone, but folding the same-speaker
			// segments reconstitutes "Thanks for watching" — the silent-stream case.
			const me = [seg("Thanks", 30, 31), seg("for watching", 31, 32)];
			expect(mergeDiarized(me, [])).toBe("");
		});

		it("drops another split outro family (see you / next time)", () => {
			const them = [seg("See you", 40, 41), seg("next time", 41, 42)];
			expect(mergeDiarized([], them)).toBe("");
		});

		it("keeps real speech that surrounds a split boundary", () => {
			const them = [seg("Let me", 0, 1), seg("share my screen", 1, 2)];
			expect(mergeDiarized([], them)).toBe("Them: Let me share my screen");
		});

		it("keeps a folded line where real content sits beside a split ghost tail", () => {
			// Whole-line filter is conservative: when a ghost is split into
			// fragments that each pass the per-segment filter and fold onto a line
			// that also carries genuine content, the line is kept (real content
			// present). A whole ghost segment would already be dropped upstream.
			const me = [
				seg("okay sounds good", 0, 2),
				seg("thanks", 2, 3),
				seg("for watching", 3, 4),
			];
			expect(mergeDiarized(me, [])).toBe("Me: okay sounds good thanks for watching");
		});
	});

	it("handles a realistic interleaved conversation with dedupe and filtering", () => {
		const me = [
			seg("Hi, thanks for joining", 0, 3),
			seg("Hi, thanks for joining", 0, 3), // chunk-overlap duplicate
			seg("Sounds good", 12, 13),
		];
		const them = [
			seg("Happy to be here", 4, 6),
			seg("bye", 30, 31), // hallucination outside any them window
			seg("Let me share my screen", 8, 11),
		];
		const windows: SpeechWindows = {
			me: [[0, 3], [12, 13]],
			them: [[4, 6], [8, 11]],
		};
		expect(mergeDiarized(me, them, windows)).toBe(
			[
				"Me: Hi, thanks for joining",
				"Them: Happy to be here Let me share my screen",
				"Me: Sounds good",
			].join("\n")
		);
	});
});
