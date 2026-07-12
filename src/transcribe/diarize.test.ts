import { describe, expect, it } from "vitest";
import { mergeDiarized, type DiarSegment, type SpeechWindows } from "./diarize";

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
