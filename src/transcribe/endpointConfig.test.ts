import { afterEach, describe, expect, it } from "vitest";
import {
	getTranscribeBaseUrl,
	getTranscribeModelOverride,
	setTranscribeBaseUrl,
	setTranscribeModelOverride,
} from "./endpointConfig";

afterEach(() => {
	// Reset to the defaults so tests don't leak state.
	setTranscribeBaseUrl("https://api.openai.com/v1");
	setTranscribeModelOverride("");
});

describe("endpointConfig", () => {
	it("defaults to the OpenAI base URL", () => {
		expect(getTranscribeBaseUrl()).toBe("https://api.openai.com/v1");
	});

	it("stores a custom base URL", () => {
		setTranscribeBaseUrl("https://proxy.example.com/v1");
		expect(getTranscribeBaseUrl()).toBe("https://proxy.example.com/v1");
	});

	it("strips trailing slashes", () => {
		setTranscribeBaseUrl("https://proxy.example.com/v1/");
		expect(getTranscribeBaseUrl()).toBe("https://proxy.example.com/v1");
	});

	it("falls back to the default for an empty value", () => {
		setTranscribeBaseUrl("");
		expect(getTranscribeBaseUrl()).toBe("https://api.openai.com/v1");
	});

	it("defaults the model override to empty", () => {
		expect(getTranscribeModelOverride()).toBe("");
	});

	it("stores and trims a model override", () => {
		setTranscribeModelOverride("  llm-gateway/whisper  ");
		expect(getTranscribeModelOverride()).toBe("llm-gateway/whisper");
	});
});
