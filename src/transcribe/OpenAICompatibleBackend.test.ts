import { describe, expect, it } from "vitest";
import type { App } from "obsidian";
import { OpenAICompatibleBackend, type TranscribeConfig } from "./OpenAICompatibleBackend";
import { DEFAULT_API_SETTINGS } from "./vendor/ApiSettings";

function config(over: Partial<TranscribeConfig> = {}): TranscribeConfig {
	return {
		baseUrl: "https://api.example.com/v1",
		apiKey: "sk-test",
		model: DEFAULT_API_SETTINGS.model,
		modelOverride: "",
		chatModel: "",
		language: "en",
		postProcessingEnabled: false,
		dictionaryCorrectionEnabled: false,
		userDictionaries: DEFAULT_API_SETTINGS.userDictionaries,
		debugMode: false,
		...over,
	};
}

const app = {} as App;

describe("OpenAICompatibleBackend.validateConfig", () => {
	it("is ok with a base URL, key, and model", async () => {
		const backend = new OpenAICompatibleBackend(app, config());
		expect(await backend.validateConfig()).toEqual({ ok: true });
	});

	it("fails without a base URL", async () => {
		const backend = new OpenAICompatibleBackend(app, config({ baseUrl: "  " }));
		const r = await backend.validateConfig();
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/base url/i);
	});

	it("fails without an API key", async () => {
		const backend = new OpenAICompatibleBackend(app, config({ apiKey: "" }));
		const r = await backend.validateConfig();
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/api key/i);
	});

	it("fails without a model", async () => {
		const backend = new OpenAICompatibleBackend(
			app,
			config({ model: "" as unknown as TranscribeConfig["model"] })
		);
		const r = await backend.validateConfig();
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/model/i);
	});

	it("reports its id", () => {
		expect(new OpenAICompatibleBackend(app, config()).id).toBe("openai-compatible");
	});
});
