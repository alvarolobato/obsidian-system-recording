/**
 * The one fetcher for an OpenAI-compatible `/models` endpoint, shared by both
 * the transcription and enrichment settings. {@link fetchModelIds} does the
 * work and throws on any failure; the two callers wrap it to match their own
 * error contracts (see {@link listModels} here, and `enrich/models.ts`).
 */
import { requestUrl } from "obsidian";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ListModelsOptions {
	baseUrl: string;
	apiKey: string;
}

/** Pulls model ids out of a parsed `/models` response. Tolerates the OpenAI shape (`{ data: [{ id }] }`) as well as gateways that return a bare array of ids or objects. */
export function parseModelIds(json: unknown): string[] {
	const raw: unknown[] = Array.isArray(json)
		? json
		: Array.isArray((json as { data?: unknown } | undefined)?.data)
			? (json as { data: unknown[] }).data
			: [];
	const ids = raw
		.map((entry) =>
			typeof entry === "string" ? entry : (entry as { id?: unknown })?.id
		)
		.filter((id): id is string => typeof id === "string" && id.length > 0);
	return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

/**
 * GETs `${baseUrl}/models` and returns the sorted, de-duplicated list of ids.
 * Throws on a non-2xx response or a timeout.
 *
 * requestUrl can't be aborted, so it's raced against a timeout to guarantee the
 * caller's promise settles; otherwise a stalled gateway can leave a "Test
 * connection" or "Load models" button disabled forever.
 */
export async function fetchModelIds(
	baseUrl: string,
	apiKey: string,
	timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<string[]> {
	const url = `${baseUrl.replace(/\/+$/, "")}/models`;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new Error(
						`Request timed out after ${Math.round(timeoutMs / 1000)}s`
					)
				),
			timeoutMs
		);
	});
	const request = requestUrl({
		url,
		method: "GET",
		headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
		throw: false,
	});
	let res;
	try {
		res = await Promise.race([request, timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
	if (res.status < 200 || res.status >= 300) {
		throw new Error(`HTTP ${res.status}`);
	}
	return parseModelIds(res.json);
}

/**
 * Null-on-failure wrapper for the optional "Load models" button next to the
 * transcription model field: any failure (network, non-2xx, timeout, bad body)
 * just returns `null` so the caller falls back to manual entry, no error noise.
 */
export async function listModels(
	opts: ListModelsOptions
): Promise<string[] | null> {
	try {
		return await fetchModelIds(opts.baseUrl, opts.apiKey);
	} catch {
		return null;
	}
}
