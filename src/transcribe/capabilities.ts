/**
 * Capability lookup for the configured endpoint. A plain OpenAI-compatible
 * `/models` list returns ids only, with no hint of what each model can do — so
 * we can't tell a chat model from a transcription model by asking it. LiteLLM,
 * however, exposes per-model metadata (including a `mode` field) via its
 * `/model/info` endpoint, which mirrors the LiteLLM model-cost map. When that's
 * reachable we use it as the source of truth for which models transcribe;
 * otherwise capabilities are simply "unknown" and the caller falls back to
 * probing the model directly.
 */
import { requestUrl } from "obsidian";

const DEFAULT_TIMEOUT_MS = 15_000;

/** What we care about per model. Extendable, but transcription is the only capability the STT picker needs today. */
export interface ModelCapability {
	/** True when the endpoint reports this model can transcribe audio (LiteLLM `mode: "audio_transcription"`). */
	transcription: boolean;
}

/** LiteLLM's `mode` value for speech-to-text models. */
const TRANSCRIPTION_MODE = "audio_transcription";

/**
 * Parses a LiteLLM `/model/info` body into a name→capability map. Returns
 * `null` when the payload isn't the LiteLLM shape (a `data` array whose entries
 * carry `model_name` and a `model_info` object), so the caller can tell "not a
 * capability-aware endpoint" apart from "endpoint says nothing transcribes".
 * Entries whose `mode` is absent are still recorded (as non-transcription) so a
 * known-but-unclassified model doesn't masquerade as speech-to-text.
 */
export function parseModelInfoCapabilities(
	json: unknown
): Map<string, ModelCapability> | null {
	const data = (json as { data?: unknown } | undefined)?.data;
	if (!Array.isArray(data)) return null;
	const caps = new Map<string, ModelCapability>();
	let sawModelInfo = false;
	for (const entry of data) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { model_name?: unknown; model_info?: unknown };
		const name = typeof e.model_name === "string" ? e.model_name : null;
		if (!name) continue;
		const info =
			e.model_info && typeof e.model_info === "object"
				? (e.model_info as { mode?: unknown })
				: null;
		if (info) sawModelInfo = true;
		const mode = typeof info?.mode === "string" ? info.mode : null;
		caps.set(name, { transcription: mode === TRANSCRIPTION_MODE });
	}
	// A `data` array with no recognizable `model_info` isn't the LiteLLM shape
	// — treat it as "no capability info" rather than "nothing transcribes".
	if (!sawModelInfo) return null;
	return caps;
}

/**
 * Fetches per-model capabilities from a LiteLLM proxy, or `null` when the
 * endpoint isn't LiteLLM / doesn't expose them. `/model/info` lives at the
 * proxy root, so we try it both as-is and with a trailing `/v1` stripped (the
 * shared endpoint is usually `https://host/v1`). Any failure — non-2xx,
 * timeout, wrong shape — collapses to `null` so the caller falls back to
 * probing individual models.
 */
export async function fetchModelCapabilities(
	baseUrl: string,
	apiKey: string,
	timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Map<string, ModelCapability> | null> {
	const trimmed = baseUrl.replace(/\/+$/, "");
	const roots = new Set<string>([trimmed]);
	// LiteLLM's /model/info sits at the proxy root; the shared endpoint is
	// typically the OpenAI-style ".../v1", so also try one level up.
	if (/\/v1$/.test(trimmed)) roots.add(trimmed.replace(/\/v1$/, ""));
	for (const root of roots) {
		const caps = await tryFetch(`${root}/model/info`, apiKey, timeoutMs);
		if (caps) return caps;
	}
	return null;
}

async function tryFetch(
	url: string,
	apiKey: string,
	timeoutMs: number
): Promise<Map<string, ModelCapability> | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
	});
	try {
		const res = await Promise.race([
			requestUrl({
				url,
				method: "GET",
				headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
				throw: false,
			}),
			timeout,
		]);
		if (res.status < 200 || res.status >= 300) return null;
		return parseModelInfoCapabilities(res.json);
	} catch {
		return null;
	} finally {
		if (timer) clearTimeout(timer);
	}
}
