/**
 * Lists model ids from the transcription endpoint's `/models` route. Separate
 * from `enrich/models.ts` (which throws, and is used to drive the shared
 * "Test connection" flow): this one is meant for a lightweight, optional
 * lookup next to the transcription model field, so it reports failure as
 * `null` rather than an error — the caller just falls back to manual entry.
 */
import { requestUrl } from "obsidian";

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
 * GETs `${baseUrl}/models` and returns the sorted list of ids, or `null` on
 * any failure (network error, non-2xx, unparseable body). Never throws.
 */
export async function listModels(
	opts: ListModelsOptions
): Promise<string[] | null> {
	try {
		const res = await requestUrl({
			url: `${opts.baseUrl.replace(/\/+$/, "")}/models`,
			method: "GET",
			headers: opts.apiKey
				? { Authorization: `Bearer ${opts.apiKey}` }
				: {},
			throw: false,
		});
		if (res.status < 200 || res.status >= 300) return null;
		return parseModelIds(res.json);
	} catch {
		return null;
	}
}
