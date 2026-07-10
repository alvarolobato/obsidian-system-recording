/**
 * Owned "endpoint seam" for the vendored transcription engine.
 *
 * The vendored OpenAI clients hardcode `https://api.openai.com/v1`. Rather than
 * editing the engine, the three thin client wrappers
 * (`WhisperClient`, `GPT4oClient`, `GPTDictionaryCorrectionService`) are the
 * only vendored files patched to read the base URL from here, so Meeting
 * Copilot can point transcription at any OpenAI-compatible endpoint (LiteLLM,
 * Azure, …) — the same endpoint used for enrichment. See VENDOR.md.
 */
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

let baseUrl = DEFAULT_BASE_URL;
let modelOverride = "";

/** Sets the `/v1` base URL used by the vendored transcription HTTP clients. */
export function setTranscribeBaseUrl(url: string): void {
	const trimmed = url.replace(/\/+$/, "");
	baseUrl = trimmed.length > 0 ? trimmed : DEFAULT_BASE_URL;
}

/** Returns the base URL the vendored clients should target. */
export function getTranscribeBaseUrl(): string {
	return baseUrl;
}

/**
 * Overrides the model id sent on the wire (for gateways whose deployment names
 * differ from OpenAI's, e.g. a LiteLLM `llm-gateway/whisper`). The engine still
 * routes Whisper vs GPT-4o by the canonical model in settings; this only
 * changes the `model` field in the request. Empty string = no override.
 */
export function setTranscribeModelOverride(id: string): void {
	modelOverride = (id ?? "").trim();
}

/** Returns the wire model id override, or "" when the canonical id should be used. */
export function getTranscribeModelOverride(): string {
	return modelOverride;
}
