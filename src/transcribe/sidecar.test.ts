import { describe, expect, it } from "vitest";
import {
	baseRecordingPathOf,
	isSidecarPath,
	parseSpeechWindows,
	sidecarPathsFor,
} from "./sidecar";

describe("isSidecarPath / baseRecordingPathOf", () => {
	it("recognizes the three sidecar kinds and maps them back to the recording", () => {
		for (const p of [
			"Meetings/foo.me.wav",
			"Meetings/foo.them.wav",
			"Meetings/foo.speech.json",
		]) {
			expect(isSidecarPath(p)).toBe(true);
			expect(baseRecordingPathOf(p)).toBe("Meetings/foo.wav");
		}
	});

	it("treats a plain recording (and unrelated files) as non-sidecars", () => {
		expect(isSidecarPath("Meetings/foo.wav")).toBe(false);
		expect(baseRecordingPathOf("Meetings/foo.wav")).toBeNull();
		expect(isSidecarPath("Meetings/foo.md")).toBe(false);
		expect(baseRecordingPathOf("notes/x.json")).toBeNull();
	});

	it("round-trips with sidecarPathsFor", () => {
		const rec = "Meetings/Standup/2026-01-01-2.wav";
		const sc = sidecarPathsFor(rec);
		expect(baseRecordingPathOf(sc.me)).toBe(rec);
		expect(baseRecordingPathOf(sc.them)).toBe(rec);
		expect(baseRecordingPathOf(sc.speech)).toBe(rec);
	});
});

describe("sidecarPathsFor", () => {
	it("derives the me/them/speech paths from a recording path", () => {
		expect(sidecarPathsFor("Meetings/Standup/foo.wav")).toEqual({
			me: "Meetings/Standup/foo.me.wav",
			them: "Meetings/Standup/foo.them.wav",
			speech: "Meetings/Standup/foo.speech.json",
		});
	});

	it("keeps disambiguation suffixes in the base name", () => {
		expect(sidecarPathsFor("recordings/2026-01-01-2.wav").me).toBe(
			"recordings/2026-01-01-2.me.wav"
		);
	});

	it("only strips a trailing .wav (case-insensitive)", () => {
		expect(sidecarPathsFor("a/b.WAV").them).toBe("a/b.them.wav");
		// A leading path segment that happens to contain "wav" is left alone.
		expect(sidecarPathsFor("wav/clip.wav").speech).toBe(
			"wav/clip.speech.json"
		);
	});
});

describe("parseSpeechWindows", () => {
	it("parses a well-formed speech.json", () => {
		const raw = JSON.stringify({
			me: [[0, 1.5], [3, 4]],
			them: [[1.5, 3]],
		});
		expect(parseSpeechWindows(raw)).toEqual({
			me: [[0, 1.5], [3, 4]],
			them: [[1.5, 3]],
		});
	});

	it("accepts empty window lists (found no speech on a stream)", () => {
		expect(parseSpeechWindows('{"me":[],"them":[]}')).toEqual({
			me: [],
			them: [],
		});
	});

	it("returns undefined on invalid JSON", () => {
		expect(parseSpeechWindows("not json")).toBeUndefined();
	});

	it("returns undefined when a stream is missing or malformed", () => {
		expect(parseSpeechWindows('{"me":[[0,1]]}')).toBeUndefined();
		expect(
			parseSpeechWindows('{"me":[[0,1]],"them":"nope"}')
		).toBeUndefined();
		expect(
			parseSpeechWindows('{"me":[[0]],"them":[]}')
		).toBeUndefined();
		expect(
			parseSpeechWindows('{"me":[["a","b"]],"them":[]}')
		).toBeUndefined();
	});
});
