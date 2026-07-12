import { describe, expect, it } from "vitest";
import {
	baseRecordingCandidatesOf,
	isSidecarPath,
	parseSpeechWindows,
	sidecarPathsFor,
} from "./sidecar";

describe("isSidecarPath / baseRecordingCandidatesOf", () => {
	it("recognizes the audio sidecars and maps them back to the recording", () => {
		for (const ext of ["wav", "m4a"]) {
			for (const kind of ["me", "them"]) {
				const p = `Meetings/foo.${kind}.${ext}`;
				expect(isSidecarPath(p)).toBe(true);
				expect(baseRecordingCandidatesOf(p)).toEqual([
					`Meetings/foo.${ext}`,
				]);
			}
		}
	});

	it("maps speech.json to a candidate per recording format", () => {
		const p = "Meetings/foo.speech.json";
		expect(isSidecarPath(p)).toBe(true);
		expect(baseRecordingCandidatesOf(p)).toEqual([
			"Meetings/foo.wav",
			"Meetings/foo.m4a",
		]);
	});

	it("preserves the sidecar's extension case in the parent candidate", () => {
		// Vault lookups are case-sensitive; a lowercased candidate would miss
		// a manually renamed foo.WAV and orphan-sweep its live sidecar.
		expect(baseRecordingCandidatesOf("Meetings/foo.me.WAV")).toEqual([
			"Meetings/foo.WAV",
		]);
	});

	it("treats a plain recording (and unrelated files) as non-sidecars", () => {
		expect(isSidecarPath("Meetings/foo.wav")).toBe(false);
		expect(baseRecordingCandidatesOf("Meetings/foo.wav")).toEqual([]);
		expect(isSidecarPath("Meetings/foo.m4a")).toBe(false);
		expect(baseRecordingCandidatesOf("Meetings/foo.m4a")).toEqual([]);
		expect(isSidecarPath("Meetings/foo.md")).toBe(false);
		expect(baseRecordingCandidatesOf("notes/x.json")).toEqual([]);
	});

	it("round-trips with sidecarPathsFor", () => {
		for (const rec of [
			"Meetings/Standup/2026-01-01-2.wav",
			"Meetings/Standup/2026-01-01-2.m4a",
		]) {
			const sc = sidecarPathsFor(rec);
			expect(baseRecordingCandidatesOf(sc.me)).toEqual([rec]);
			expect(baseRecordingCandidatesOf(sc.them)).toEqual([rec]);
			expect(baseRecordingCandidatesOf(sc.speech)).toContain(rec);
		}
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

	it("sidecars share the recording's extension", () => {
		expect(sidecarPathsFor("Meetings/Standup/foo.m4a")).toEqual({
			me: "Meetings/Standup/foo.me.m4a",
			them: "Meetings/Standup/foo.them.m4a",
			speech: "Meetings/Standup/foo.speech.json",
		});
	});

	it("keeps disambiguation suffixes in the base name", () => {
		expect(sidecarPathsFor("recordings/2026-01-01-2.wav").me).toBe(
			"recordings/2026-01-01-2.me.wav"
		);
	});

	it("only strips a trailing audio extension (case-insensitive)", () => {
		expect(sidecarPathsFor("a/b.WAV").them).toBe("a/b.them.wav");
		expect(sidecarPathsFor("a/b.M4A").them).toBe("a/b.them.m4a");
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
