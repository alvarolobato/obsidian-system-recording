import { describe, expect, it } from "vitest";
import { makeProbeWav, probeKey, responseHasSegments } from "./probe";

describe("makeProbeWav", () => {
	const wav = makeProbeWav();
	const view = new DataView(wav);

	function readAscii(offset: number, length: number): string {
		let s = "";
		for (let i = 0; i < length; i++) {
			s += String.fromCharCode(view.getUint8(offset + i));
		}
		return s;
	}

	it("is a ~0.5s, 16kHz mono 16-bit clip", () => {
		// 0.5s * 16000 samples/s * 2 bytes/sample = 16000 bytes of audio data,
		// plus the 44-byte header.
		expect(wav.byteLength).toBe(44 + 16000);
	});

	it("has a well-formed RIFF/WAVE header", () => {
		expect(readAscii(0, 4)).toBe("RIFF");
		expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
		expect(readAscii(8, 4)).toBe("WAVE");
		expect(readAscii(12, 4)).toBe("fmt ");
		expect(view.getUint32(16, true)).toBe(16); // fmt chunk size
		expect(view.getUint16(20, true)).toBe(1); // PCM
		expect(view.getUint16(22, true)).toBe(1); // mono
		expect(view.getUint32(24, true)).toBe(16000); // sample rate
		expect(view.getUint32(28, true)).toBe(32000); // byte rate
		expect(view.getUint16(32, true)).toBe(2); // block align
		expect(view.getUint16(34, true)).toBe(16); // bits per sample
		expect(readAscii(36, 4)).toBe("data");
		expect(view.getUint32(40, true)).toBe(16000); // data size
	});

	it("carries actual (non-silent) samples", () => {
		let sawNonZero = false;
		for (let i = 0; i < 100; i++) {
			if (view.getInt16(44 + i * 2, true) !== 0) sawNonZero = true;
		}
		expect(sawNonZero).toBe(true);
	});
});

describe("responseHasSegments", () => {
	it("is true for a verbose_json response with segments", () => {
		expect(
			responseHasSegments({
				text: "hello world",
				segments: [{ id: 0, text: "hello world", start: 0, end: 1 }],
			})
		).toBe(true);
	});

	it("is false when segments is an empty array", () => {
		expect(responseHasSegments({ text: "hello world", segments: [] })).toBe(
			false
		);
	});

	it("is false when segments is missing (plain-text fallback)", () => {
		expect(responseHasSegments({ text: "hello world" })).toBe(false);
	});

	it("is false for non-object or null input", () => {
		expect(responseHasSegments(null)).toBe(false);
		expect(responseHasSegments(undefined)).toBe(false);
		expect(responseHasSegments("hello world")).toBe(false);
		expect(responseHasSegments(42)).toBe(false);
	});

	it("is false when segments isn't an array", () => {
		expect(responseHasSegments({ segments: "nope" })).toBe(false);
	});
});

describe("probeKey", () => {
	it("joins base URL and wire model with a stable separator", () => {
		expect(probeKey("https://gw.example.com/v1", "llmgateway/whisper")).toBe(
			"https://gw.example.com/v1::llmgateway/whisper"
		);
	});

	it("changes when either input changes", () => {
		const a = probeKey("https://a.example.com/v1", "whisper-1");
		expect(probeKey("https://b.example.com/v1", "whisper-1")).not.toBe(a);
		expect(probeKey("https://a.example.com/v1", "whisper-2")).not.toBe(a);
	});
});
