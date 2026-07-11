import { describe, expect, it } from "vitest";
import {
	canSeparateSpeakers,
	inferSttApiType,
	STT_MODELS,
	type DiarizationGateSettings,
} from "./sttModel";

describe("inferSttApiType", () => {
	it("maps whisper names (incl. gateway ids) to the timestamped whisper family", () => {
		expect(inferSttApiType("whisper-1")).toBe("whisper-1-ts");
		expect(inferSttApiType("llm-gateway/whisper")).toBe("whisper-1-ts");
		expect(inferSttApiType("Whisper-Large")).toBe("whisper-1-ts");
	});

	it("maps mini names to the gpt-4o-mini family", () => {
		expect(inferSttApiType("gpt-4o-mini-transcribe")).toBe(
			"gpt-4o-mini-transcribe"
		);
		expect(inferSttApiType("company/gpt-4o-MINI")).toBe(
			"gpt-4o-mini-transcribe"
		);
	});

	it("defaults everything else to gpt-4o-transcribe", () => {
		expect(inferSttApiType("gpt-4o-transcribe")).toBe("gpt-4o-transcribe");
		expect(inferSttApiType("llm-gateway/transcribe")).toBe(
			"gpt-4o-transcribe"
		);
		expect(inferSttApiType("something-unknown")).toBe("gpt-4o-transcribe");
	});

	it("always returns a valid engine family", () => {
		for (const id of ["whisper-1", "x", "gpt-4o-mini", ""]) {
			expect(STT_MODELS as readonly string[]).toContain(
				inferSttApiType(id)
			);
		}
	});
});

describe("canSeparateSpeakers", () => {
	const KEY = "https://gw.example.com/v1::whisper-1";

	const base: DiarizationGateSettings = {
		diarizationEnabled: true,
		sttApiType: "whisper-1-ts",
		sttTimestampsSupported: true,
		sttTimestampsProbeKey: KEY,
	};

	it("is true when every condition holds", () => {
		expect(canSeparateSpeakers(base, KEY)).toBe(true);
	});

	it("is false when diarization is turned off", () => {
		expect(
			canSeparateSpeakers({ ...base, diarizationEnabled: false }, KEY)
		).toBe(false);
	});

	it("is false for any family other than whisper-1-ts", () => {
		for (const sttApiType of [
			"whisper-1",
			"gpt-4o-transcribe",
			"gpt-4o-mini-transcribe",
		] as const) {
			expect(canSeparateSpeakers({ ...base, sttApiType }, KEY)).toBe(false);
		}
	});

	it("is false when timestamps were never probed", () => {
		expect(
			canSeparateSpeakers(
				{ ...base, sttTimestampsSupported: null },
				KEY
			)
		).toBe(false);
	});

	it("is false when the probe came back negative", () => {
		expect(
			canSeparateSpeakers(
				{ ...base, sttTimestampsSupported: false },
				KEY
			)
		).toBe(false);
	});

	it("is false when the stored probe key is stale (endpoint or model changed since)", () => {
		expect(canSeparateSpeakers(base, "https://gw.example.com/v1::whisper-2")).toBe(
			false
		);
		expect(canSeparateSpeakers({ ...base, sttTimestampsProbeKey: "" }, KEY)).toBe(
			false
		);
	});
});
