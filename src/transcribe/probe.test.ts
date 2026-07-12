import { beforeEach, describe, expect, it, vi } from "vitest";

const { requestUrl } = vi.hoisted(() => ({ requestUrl: vi.fn() }));
vi.mock("obsidian", () => ({ requestUrl }));

import {
	classifySttResponse,
	makeProbeWav,
	probeKey,
	probeSttSupport,
	responseHasSegmentsArray,
} from "./probe";

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

describe("responseHasSegmentsArray", () => {
	it("is true for a verbose_json response with segments", () => {
		expect(
			responseHasSegmentsArray({
				text: "hello world",
				segments: [{ id: 0, text: "hello world", start: 0, end: 1 }],
			})
		).toBe(true);
	});

	it("is true when segments is an empty array (quiet clip, backend honored verbose_json)", () => {
		expect(
			responseHasSegmentsArray({ text: "", segments: [] })
		).toBe(true);
	});

	it("is false when segments is missing (plain-text fallback)", () => {
		expect(responseHasSegmentsArray({ text: "hello world" })).toBe(false);
	});

	it("is false for non-object or null input", () => {
		expect(responseHasSegmentsArray(null)).toBe(false);
		expect(responseHasSegmentsArray(undefined)).toBe(false);
		expect(responseHasSegmentsArray("hello world")).toBe(false);
		expect(responseHasSegmentsArray(42)).toBe(false);
	});

	it("is false when segments isn't an array", () => {
		expect(responseHasSegmentsArray({ segments: "nope" })).toBe(false);
	});
});

describe("classifySttResponse", () => {
	it("reports transcription + timestamps for a 2xx with segments (timestamps checked)", () => {
		expect(classifySttResponse(200, { segments: [] }, true)).toEqual({
			transcription: "supported",
			timestamps: "supported",
		});
	});

	it("reports timestamps unsupported for a 2xx with no segments (timestamps checked)", () => {
		expect(classifySttResponse(200, { text: "hi" }, true)).toEqual({
			transcription: "supported",
			timestamps: "unsupported",
		});
	});

	it("leaves timestamps 'unknown' on a 2xx when they weren't requested", () => {
		expect(classifySttResponse(200, { text: "hi" }, false)).toEqual({
			transcription: "supported",
			timestamps: "unknown",
		});
	});

	it("treats a client rejection (400/404/415/422) as 'model can't transcribe'", () => {
		for (const status of [400, 404, 405, 415, 422]) {
			expect(classifySttResponse(status, undefined, true)).toEqual({
				transcription: "unsupported",
				timestamps: "unsupported",
			});
		}
	});

	it("is 'unknown' on auth/rate-limit/server errors", () => {
		for (const status of [401, 403, 429, 500, 503]) {
			expect(classifySttResponse(status, undefined, true)).toEqual({
				transcription: "unknown",
				timestamps: "unknown",
			});
		}
	});
});

describe("probeSttSupport", () => {
	const opts = {
		baseUrl: "https://gw.example.com/v1",
		apiKey: "sk-test",
		wireModel: "whisper-1",
	};

	beforeEach(() => {
		requestUrl.mockReset();
	});

	it("detects transcription + timestamps when asked for timestamps", async () => {
		requestUrl.mockResolvedValue({ status: 200, json: { segments: [] } });
		expect(
			await probeSttSupport({ ...opts, withTimestamps: true })
		).toMatchObject({
			transcription: "supported",
			timestamps: "supported",
			status: 200,
		});
	});

	it("requests plain json (no timestamp verdict) when not asked for timestamps", async () => {
		requestUrl.mockResolvedValue({ status: 200, json: { text: "hi" } });
		const result = await probeSttSupport({ ...opts, withTimestamps: false });
		expect(result).toMatchObject({
			transcription: "supported",
			timestamps: "unknown",
		});
		expect(requestUrl).toHaveBeenCalledTimes(1);
	});

	it("marks a rejected model as non-transcription", async () => {
		requestUrl.mockResolvedValue({ status: 400, json: undefined });
		expect(await probeSttSupport(opts)).toMatchObject({
			transcription: "unsupported",
			timestamps: "unsupported",
			status: 400,
		});
	});

	it("is 'unknown' on a transient error, reporting the status", async () => {
		requestUrl.mockResolvedValue({ status: 429, json: undefined });
		expect(await probeSttSupport(opts)).toMatchObject({
			transcription: "unknown",
			timestamps: "unknown",
			status: 429,
			detail: "HTTP 429",
		});
	});

	it("is 'unknown' when the request throws, reporting the error", async () => {
		requestUrl.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
		const result = await probeSttSupport(opts);
		expect(result).toMatchObject({
			transcription: "unknown",
			timestamps: "unknown",
			status: null,
		});
		expect(result.detail).toContain("ENOTFOUND");
	});

	it("is 'unknown' when the body can't be parsed as JSON", async () => {
		requestUrl.mockResolvedValue({
			status: 200,
			get json(): unknown {
				throw new Error("invalid json");
			},
		});
		expect(
			await probeSttSupport({ ...opts, withTimestamps: true })
		).toMatchObject({ transcription: "unknown", timestamps: "unknown" });
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
