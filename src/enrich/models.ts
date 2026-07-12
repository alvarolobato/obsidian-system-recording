import { fetchModelIds } from "../transcribe/models";

/**
 * Lists model ids from an OpenAI-compatible `/models` endpoint, doubling as the
 * enrichment "Test connection" check: it throws on failure so the caller can
 * surface the reason. Thin wrapper over the shared {@link fetchModelIds}.
 */
export async function listModels(
	baseUrl: string,
	apiKey: string,
	timeoutMs?: number
): Promise<string[]> {
	return fetchModelIds(baseUrl, apiKey, timeoutMs);
}
