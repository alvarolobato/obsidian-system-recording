import { describe, expect, it } from "vitest";
import {
	encodeWavFromFloat32,
	plannedCoverageSeconds,
	plannedSpeechSeconds,
	planPregatedChunks,
	rangesToChunkBounds,
	type PregateOptions,
} from "./pregate";

// Defaults roughly mirror the whisper model config the runner passes
// (25s chunks, 5s overlap) with generous padding/merge for tests.
const OPTS: PregateOptions = {
	padding: 0.3,
	maxChunkDuration: 25,
	overlap: 5,
	mergeGap: 1,
	minChunkDuration: 3,
};

describe("planPregatedChunks", () => {
	it("returns [] for missing/blank windows (caller falls back to a full pass)", () => {
		expect(planPregatedChunks(undefined, 100, OPTS)).toEqual([]);
		expect(planPregatedChunks([], 100, OPTS)).toEqual([]);
	});

	it("returns [] for a non-positive duration", () => {
		expect(planPregatedChunks([[1, 2]], 0, OPTS)).toEqual([]);
		expect(planPregatedChunks([[1, 2]], -5, OPTS)).toEqual([]);
	});

	it("pads a single window and clamps to the stream bounds", () => {
		const chunks = planPregatedChunks([[10, 12]], 100, OPTS);
		expect(chunks).toEqual([{ start: 9.7, end: 12.3 }]);
	});

	it("clamps padding at 0 and at totalDuration", () => {
		// Window spans the whole (short) stream; padding can't push past [0, 20].
		const chunks = planPregatedChunks([[0, 20]], 20, OPTS);
		expect(chunks).toEqual([{ start: 0, end: 20 }]);
	});

	it("merges overlapping windows into one chunk", () => {
		// After padding, [10,15] -> [9.7,15.3] and [15,20] -> [14.7,20.3] overlap.
		const chunks = planPregatedChunks([[10, 15], [15, 20]], 100, OPTS);
		expect(chunks).toEqual([{ start: 9.7, end: 20.3 }]);
	});

	it("bridges a gap no wider than mergeGap but not a wider one", () => {
		// Gap between padded windows = 1.0 (== mergeGap) -> bridged.
		const bridged = planPregatedChunks([[10, 11], [12.6, 13.6]], 100, OPTS);
		expect(bridged).toEqual([{ start: 9.7, end: 13.9 }]);

		// A clearly wider gap stays two separate chunks.
		const split = planPregatedChunks([[10, 11], [40, 41]], 100, OPTS);
		expect(split).toEqual([
			{ start: 9.7, end: 11.3 },
			{ start: 39.7, end: 41.3 },
		]);
	});

	it("keeps a short standalone window (does not drop real speech)", () => {
		const chunks = planPregatedChunks([[10, 10.2]], 100, {
			...OPTS,
			padding: 0,
		});
		expect(chunks).toEqual([{ start: 10, end: 10.2 }]);
	});

	it("splits a long region into overlapping sub-chunks with the right step", () => {
		// One 0..60 region (no padding), 25s max, 5s overlap => step 20.
		const chunks = planPregatedChunks([[0, 60]], 60, {
			...OPTS,
			padding: 0,
			minChunkDuration: 3,
		});
		expect(chunks).toEqual([
			{ start: 0, end: 25 },
			{ start: 20, end: 45 },
			{ start: 40, end: 60 },
		]);
		// Every sub-chunk respects the max duration.
		for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(25);
	});

	it("keeps a trailing sub-chunk that isn't below minChunkDuration (runner config: overlap >= minChunk)", () => {
		// step = maxDur - overlap = 20, so [0,42] splits into [0,25],[20,42].
		// The tail spans 22s — far above minChunkDuration — so nothing folds and
		// the natural split is returned. In the runner's config the last sub-chunk
		// is always >= overlap (5s) >= minChunkDuration (5s), so this is the norm.
		const chunks = planPregatedChunks([[0, 42]], 42, {
			...OPTS,
			padding: 0,
			minChunkDuration: 3,
		});
		expect(chunks).toEqual([
			{ start: 0, end: 25 },
			{ start: 20, end: 42 },
		]);
	});

	it("keeps a sub-minChunk tail rather than folding it into an over-length chunk", () => {
		// minChunk (8) > overlap (5) makes the trailing chunk short enough to fold,
		// but folding it into its (full maxDur) predecessor would exceed maxDur, so
		// the guard keeps the small tail as its own chunk instead. This is why the
		// fold body is defensive: a full-length predecessor + any real tail always
		// overshoots, so we never violate the cap and never drop the tail's audio.
		const chunks = planPregatedChunks([[0, 52]], 52, {
			...OPTS,
			padding: 0,
			maxChunkDuration: 10,
			overlap: 5,
			minChunkDuration: 8,
		});
		expect(chunks.length).toBeGreaterThan(0);
		for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(10);
		// Full coverage of the region is preserved (no audio dropped by the guard).
		expect(chunks[0]?.start).toBe(0);
		expect(chunks[chunks.length - 1]?.end).toBe(52);
	});

	it("returns [] when every window is beyond the stream (all clamped away)", () => {
		expect(planPregatedChunks([[200, 300]], 100, OPTS)).toEqual([]);
	});

	it("drops non-finite window endpoints", () => {
		expect(
			planPregatedChunks(
				[
					[Number.NaN, 5],
					[10, Number.POSITIVE_INFINITY],
					[20, 21],
				],
				100,
				{ ...OPTS, padding: 0 }
			)
		).toEqual([{ start: 20, end: 21 }]);
	});

	it("keeps the advance positive even if overlap >= maxChunkDuration", () => {
		const chunks = planPregatedChunks([[0, 60]], 60, {
			...OPTS,
			padding: 0,
			maxChunkDuration: 10,
			overlap: 100,
		});
		// overlap clamped to maxDur-0.5=9.5 => step 0.5; must terminate and cover.
		expect(chunks.length).toBeGreaterThan(0);
		expect(chunks[0]?.start).toBe(0);
		expect(chunks[chunks.length - 1]?.end).toBe(60);
		for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(10);
	});

	it("orders a reversed window pair before padding", () => {
		const chunks = planPregatedChunks([[12, 10]], 100, OPTS);
		expect(chunks).toEqual([{ start: 9.7, end: 12.3 }]);
	});

	it("sorts unsorted windows", () => {
		const chunks = planPregatedChunks([[40, 41], [10, 11]], 100, {
			...OPTS,
			padding: 0,
			mergeGap: 0,
		});
		expect(chunks).toEqual([
			{ start: 10, end: 11 },
			{ start: 40, end: 41 },
		]);
	});
});

describe("rangesToChunkBounds", () => {
	it("maps ranges to absolute sample bounds + offsets", () => {
		const bounds = rangesToChunkBounds(
			[
				{ start: 1, end: 2 },
				{ start: 5, end: 6.5 },
			],
			16000,
			16000 * 100
		);
		expect(bounds).toEqual([
			{ startSample: 16000, endSample: 32000, startTime: 1, endTime: 2 },
			{ startSample: 80000, endSample: 104000, startTime: 5, endTime: 6.5 },
		]);
	});

	it("derives startTime from the (clamped, rounded) sample bounds", () => {
		// endSample clamps to totalSamples so endTime reflects the real slice.
		const bounds = rangesToChunkBounds([{ start: 98, end: 105 }], 16000, 16000 * 100);
		expect(bounds).toEqual([
			{ startSample: 16000 * 98, endSample: 16000 * 100, startTime: 98, endTime: 100 },
		]);
	});

	it("floors start and ceils end so a fractional window keeps all its audio", () => {
		const [b] = rangesToChunkBounds([{ start: 1.00005, end: 1.00006 }], 16000, 16000 * 10);
		// 1.00005*16000 = 16000.8 -> floor 16000; 1.00006*16000 = 16000.96 -> ceil 16001.
		expect(b).toEqual({ startSample: 16000, endSample: 16001, startTime: 1, endTime: 16001 / 16000 });
	});

	it("drops a range that rounds to an empty slice", () => {
		expect(rangesToChunkBounds([{ start: 5, end: 5 }], 16000, 16000 * 10)).toEqual([]);
	});
});

describe("plannedSpeechSeconds", () => {
	it("sums chunk durations (overlap counted per chunk = bytes uploaded)", () => {
		expect(
			plannedSpeechSeconds([
				{ start: 0, end: 25 },
				{ start: 20, end: 45 },
			])
		).toBe(50);
	});

	it("is 0 for an empty plan", () => {
		expect(plannedSpeechSeconds([])).toBe(0);
	});
});

describe("plannedCoverageSeconds", () => {
	it("counts overlapping chunk ranges once (distinct timeline covered)", () => {
		// Two 25s chunks overlapping 5s cover 45s of timeline, not 50.
		expect(
			plannedCoverageSeconds([
				{ start: 0, end: 25 },
				{ start: 20, end: 45 },
			])
		).toBe(45);
	});

	it("sums disjoint ranges and never exceeds their span", () => {
		expect(
			plannedCoverageSeconds([
				{ start: 0, end: 10 },
				{ start: 40, end: 41 },
			])
		).toBe(11);
	});

	it("merges touching ranges (a shared endpoint is counted once)", () => {
		expect(
			plannedCoverageSeconds([
				{ start: 0, end: 10 },
				{ start: 10, end: 20 },
			])
		).toBe(20);
	});

	it("handles unsorted input and is 0 for an empty plan", () => {
		expect(
			plannedCoverageSeconds([
				{ start: 20, end: 45 },
				{ start: 0, end: 25 },
			])
		).toBe(45);
		expect(plannedCoverageSeconds([])).toBe(0);
	});
});

describe("encodeWavFromFloat32", () => {
	it("writes a valid mono 16-bit PCM WAV header", () => {
		const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
		const buf = encodeWavFromFloat32(pcm, 16000);
		const view = new DataView(buf);
		const str = (off: number, len: number) =>
			String.fromCharCode(
				...Array.from({ length: len }, (_, i) => view.getUint8(off + i))
			);

		expect(str(0, 4)).toBe("RIFF");
		expect(str(8, 4)).toBe("WAVE");
		expect(str(12, 4)).toBe("fmt ");
		expect(view.getUint16(20, true)).toBe(1); // PCM
		expect(view.getUint16(22, true)).toBe(1); // mono
		expect(view.getUint32(24, true)).toBe(16000);
		expect(view.getUint32(28, true)).toBe(32000); // byte rate
		expect(view.getUint16(34, true)).toBe(16); // bits/sample
		expect(str(36, 4)).toBe("data");

		// Header + 2 bytes/sample; sizes agree with the sample count.
		expect(buf.byteLength).toBe(44 + pcm.length * 2);
		expect(view.getUint32(40, true)).toBe(pcm.length * 2);
		expect(view.getUint32(4, true)).toBe(36 + pcm.length * 2);
	});

	it("clamps out-of-range samples to the 16-bit extremes", () => {
		const buf = encodeWavFromFloat32(new Float32Array([2, -2]), 16000);
		const view = new DataView(buf);
		expect(view.getInt16(44, true)).toBe(0x7fff); // +full scale
		expect(view.getInt16(46, true)).toBe(-0x8000); // -full scale
	});

	it("produces an empty data section for empty PCM", () => {
		const buf = encodeWavFromFloat32(new Float32Array([]), 16000);
		expect(buf.byteLength).toBe(44);
		expect(new DataView(buf).getUint32(40, true)).toBe(0);
	});
});
