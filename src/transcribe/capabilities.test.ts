import { describe, expect, it } from "vitest";
import { parseModelInfoCapabilities } from "./capabilities";

describe("parseModelInfoCapabilities", () => {
	it("maps LiteLLM /model/info modes to a transcription flag", () => {
		const caps = parseModelInfoCapabilities({
			data: [
				{ model_name: "whisper", model_info: { mode: "audio_transcription" } },
				{
					model_name: "gpt-4o-transcribe",
					model_info: { mode: "audio_transcription" },
				},
				{ model_name: "gpt-4o", model_info: { mode: "chat" } },
				{
					model_name: "text-embedding-3-large",
					model_info: { mode: "embedding" },
				},
			],
		});
		expect(caps).not.toBeNull();
		expect(caps?.get("whisper")?.transcription).toBe(true);
		expect(caps?.get("gpt-4o-transcribe")?.transcription).toBe(true);
		expect(caps?.get("gpt-4o")?.transcription).toBe(false);
		expect(caps?.get("text-embedding-3-large")?.transcription).toBe(false);
	});

	it("records a known model with no mode as non-transcription", () => {
		const caps = parseModelInfoCapabilities({
			data: [{ model_name: "mystery", model_info: {} }],
		});
		expect(caps?.get("mystery")?.transcription).toBe(false);
	});

	it("returns null for a plain OpenAI /models shape (no model_info)", () => {
		expect(
			parseModelInfoCapabilities({
				data: [{ id: "gpt-4o" }, { id: "whisper-1" }],
			})
		).toBeNull();
	});

	it("returns null when there's no data array at all", () => {
		expect(parseModelInfoCapabilities({ models: [] })).toBeNull();
		expect(parseModelInfoCapabilities(null)).toBeNull();
		expect(parseModelInfoCapabilities("nope")).toBeNull();
	});

	it("skips entries without a usable model_name", () => {
		const caps = parseModelInfoCapabilities({
			data: [
				{ model_info: { mode: "audio_transcription" } },
				{ model_name: 42, model_info: { mode: "chat" } },
				{ model_name: "ok", model_info: { mode: "chat" } },
			],
		});
		expect(caps?.size).toBe(1);
		expect(caps?.get("ok")?.transcription).toBe(false);
	});
});
