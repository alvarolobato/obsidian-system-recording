/**
 * Pre-gating the diarized upload to speech windows (issue #67).
 *
 * The diarized path transcribes each mono stream (mic = "me", system = "them")
 * on its own. Both streams are mostly silence, yet the vendored engine chunks
 * the *whole* file — silent seconds included — and uploads every chunk, paying
 * per-chunk latency + rate-limit stalls (and inviting Whisper silence
 * hallucinations) over audio that carries no speech.
 *
 * These pure helpers turn the speech windows we already detect
 * (`vadWindows.ts` / recorder `speech.json`) into a small set of transcription
 * chunk ranges that cover only speech (padded), skipping the silent gaps. The
 * runner slices the decoded PCM to these ranges and tags each chunk with its
 * ABSOLUTE original-timeline start, so the merge stays on the shared clock
 * (`WhisperClient` offsets returned segment times by `chunk.startTime`).
 *
 * No Obsidian / Web Audio imports here, so the slicing math is unit-testable;
 * the decode + WAV-encode glue that needs an AudioContext lives in the runner.
 */

/** A planned transcription chunk, in absolute seconds of the original stream. */
export interface PregateChunk {
	start: number;
	end: number;
}

/** Tunables for {@link planPregatedChunks}; the runner sources these from the model config. */
export interface PregateOptions {
	/**
	 * Seconds added to each side of a speech window before chunking, so a word
	 * whose onset/offset sits just outside the detected window isn't clipped.
	 * Windows from local VAD are already padded; this is extra safety and also
	 * covers the recorder's (unpadded) RMS windows.
	 */
	padding: number;
	/** Longest chunk to send; a continuous speech region longer than this is split. */
	maxChunkDuration: number;
	/**
	 * Overlap between the sub-chunks of a split region, so a word straddling a
	 * split boundary is transcribed whole in at least one chunk. The diarized
	 * merge's exact-text de-dup collapses the duplicated overlap segments.
	 */
	overlap: number;
	/**
	 * Bridge windows separated by a gap no larger than this into one region, so
	 * two nearby utterances don't become two tiny requests (a little silence in
	 * the seam is cheaper than the extra round trip). Silent gaps wider than
	 * this are dropped from the upload.
	 */
	mergeGap: number;
	/**
	 * Floor for a split region's trailing sub-chunk: a tail shorter than this is
	 * folded back into the previous sub-chunk instead of being sent on its own.
	 * Does NOT drop a short *standalone* speech region — a brief real utterance
	 * ("yeah") is still uploaded.
	 */
	minChunkDuration: number;
}

/**
 * Plan the chunk ranges (absolute seconds) that cover only speech.
 *
 * Steps: pad each window and clamp to `[0, totalDuration]`; sort; merge
 * overlapping windows and bridge gaps `<= mergeGap`; split any region longer
 * than `maxChunkDuration` into `overlap`-overlapping sub-chunks, folding a
 * sub-`minChunkDuration` tail into its predecessor.
 *
 * Returns `[]` when there's nothing to gate (no/blank windows, non-positive
 * duration, or everything padded away) — the caller reads that as "fall back to
 * a full pass" so a quiet-but-real stream is never silently skipped.
 */
export function planPregatedChunks(
	windows: ReadonlyArray<readonly [number, number]> | undefined,
	totalDuration: number,
	opts: PregateOptions
): PregateChunk[] {
	if (!windows || windows.length === 0 || !(totalDuration > 0)) return [];

	const pad = Math.max(0, opts.padding);
	const mergeGap = Math.max(0, opts.mergeGap);

	// 1. Pad + clamp to the stream, dropping degenerate/out-of-range windows.
	//    Guard against a reversed pair by ordering the endpoints first, and
	//    against non-finite endpoints (NaN/Infinity) before they poison the math.
	const padded = windows
		.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
		.map(([a, b]) => {
			const lo = Math.min(a, b);
			const hi = Math.max(a, b);
			return [
				Math.max(0, lo - pad),
				Math.min(totalDuration, hi + pad),
			] as [number, number];
		})
		.filter(([s, e]) => e > s)
		.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	if (padded.length === 0) return [];

	// 2. Merge overlapping windows and bridge gaps up to mergeGap.
	const merged: Array<[number, number]> = [];
	for (const [s, e] of padded) {
		const last = merged[merged.length - 1];
		if (last && s <= last[1] + mergeGap) {
			last[1] = Math.max(last[1], e);
		} else {
			merged.push([s, e]);
		}
	}

	// 3. Split regions longer than maxChunkDuration into overlapping sub-chunks.
	const maxDur = Math.max(1, opts.maxChunkDuration);
	// Keep the advance (maxDur - overlap) positive even if a caller passes an
	// overlap >= maxDur, so the split loop always terminates.
	const overlap = Math.max(0, Math.min(opts.overlap, maxDur - 0.5));
	const minChunk = Math.max(0, opts.minChunkDuration);

	const out: PregateChunk[] = [];
	for (const [rs, re] of merged) {
		if (re - rs <= maxDur) {
			out.push({ start: rs, end: re });
			continue;
		}
		const regionChunks: PregateChunk[] = [];
		let s = rs;
		while (s < re) {
			const e = Math.min(s + maxDur, re);
			regionChunks.push({ start: s, end: e });
			if (e >= re) break;
			s = e - overlap;
		}
		// Fold a too-short trailing sub-chunk into its predecessor — but only
		// when the merged chunk still fits maxChunkDuration, so the fold can
		// never produce an over-length chunk (it can't for the runner's config,
		// where minChunkDuration <= overlap, but a caller could pass otherwise;
		// then we simply keep the small tail rather than violate the cap).
		if (regionChunks.length >= 2) {
			const last = regionChunks[regionChunks.length - 1];
			const prev = regionChunks[regionChunks.length - 2];
			if (
				last &&
				prev &&
				last.end - last.start < minChunk &&
				last.end - prev.start <= maxDur
			) {
				prev.end = last.end;
				regionChunks.pop();
			}
		}
		out.push(...regionChunks);
	}
	return out;
}

/**
 * Total speech seconds a plan uploads — the sum of chunk durations (overlaps
 * counted once per chunk). Handy for logging the silence-skipped ratio.
 */
export function plannedSpeechSeconds(chunks: ReadonlyArray<PregateChunk>): number {
	return chunks.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0);
}

/** Sample-accurate bounds + absolute offsets for one planned chunk. */
export interface PregateChunkBounds {
	/** First PCM sample index (inclusive). */
	startSample: number;
	/** Last PCM sample index (exclusive), clamped to the buffer. */
	endSample: number;
	/** Absolute start offset (seconds), derived from `startSample`. */
	startTime: number;
	/** Absolute end offset (seconds), derived from `endSample`. */
	endTime: number;
}

/**
 * Map planned second-ranges onto sample-accurate chunk bounds for a stream of
 * `totalSamples` at `sampleRate`. The offsets come from the actual (rounded,
 * clamped) sample bounds rather than the requested seconds, so the `startTime`
 * we hand each chunk exactly matches the audio we sliced — the Whisper client
 * adds it back to every segment time, so the merge stays on the shared clock.
 * Empty (start >= end after rounding) chunks are dropped.
 */
export function rangesToChunkBounds(
	ranges: ReadonlyArray<PregateChunk>,
	sampleRate: number,
	totalSamples: number
): PregateChunkBounds[] {
	const bounds: PregateChunkBounds[] = [];
	for (const r of ranges) {
		const startSample = Math.max(0, Math.floor(r.start * sampleRate));
		const endSample = Math.min(totalSamples, Math.ceil(r.end * sampleRate));
		if (endSample <= startSample) continue;
		bounds.push({
			startSample,
			endSample,
			startTime: startSample / sampleRate,
			endTime: endSample / sampleRate,
		});
	}
	return bounds;
}

/**
 * Encode a mono Float32 PCM buffer as a 16-bit little-endian WAV ArrayBuffer —
 * the format the Whisper client wraps into the upload `File`. Samples are
 * clamped to [-1, 1] before quantizing. Pure, so the header/layout is testable
 * without an AudioContext.
 */
export function encodeWavFromFloat32(pcm: Float32Array, sampleRate: number): ArrayBuffer {
	const length = pcm.length;
	const buffer = new ArrayBuffer(44 + length * 2);
	const view = new DataView(buffer);

	const writeString = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
	};

	writeString(0, "RIFF");
	view.setUint32(4, 36 + length * 2, true);
	writeString(8, "WAVE");
	writeString(12, "fmt ");
	view.setUint32(16, 16, true); // PCM fmt chunk size
	view.setUint16(20, 1, true); // audio format = PCM
	view.setUint16(22, 1, true); // channels = mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeString(36, "data");
	view.setUint32(40, length * 2, true);

	let offset = 44;
	for (let i = 0; i < length; i++) {
		const sample = Math.max(-1, Math.min(1, pcm[i] ?? 0));
		view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
		offset += 2;
	}
	return buffer;
}
