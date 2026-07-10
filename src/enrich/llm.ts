import { requestUrl } from "obsidian";

export interface ChatParams {
	baseUrl: string;
	apiKey: string;
	model: string;
	system: string;
	user: string;
	temperature?: number;
}

interface ChatResponse {
	choices?: { message?: { content?: string } }[];
	error?: { message?: string };
}

/**
 * Calls an OpenAI-compatible `/chat/completions` endpoint (OpenAI, Azure,
 * LiteLLM proxy, Ollama, …) via Obsidian's requestUrl to avoid CORS.
 */
export async function chatComplete(p: ChatParams): Promise<string> {
	const url = `${p.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const res = await requestUrl({
		url,
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${p.apiKey}`,
		},
		body: JSON.stringify({
			model: p.model,
			temperature: p.temperature ?? 0.3,
			messages: [
				{ role: "system", content: p.system },
				{ role: "user", content: p.user },
			],
		}),
		throw: false,
	});

	const data = res.json as ChatResponse | undefined;
	if (res.status < 200 || res.status >= 300) {
		const detail =
			data?.error?.message ??
			(typeof res.text === "string" ? res.text.slice(0, 300) : "");
		throw new Error(`LLM request failed (${res.status}): ${detail}`);
	}

	const content = data?.choices?.[0]?.message?.content;
	if (!content || content.trim().length === 0) {
		throw new Error("LLM returned no content");
	}
	return content.trim();
}
