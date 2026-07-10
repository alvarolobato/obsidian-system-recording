export type OpenAIChatRole = 'system' | 'user' | 'assistant';

export interface OpenAIChatMessage {
	role: OpenAIChatRole;
	content: string;
}

export interface OpenAIResponseFormat {
	type: string;
}

export interface OpenAIChatRequest {
	model: string;
	messages: OpenAIChatMessage[];
	temperature?: number;
	max_tokens?: number;
	top_p?: number;
	stream?: boolean;
	response_format?: OpenAIResponseFormat;
	[key: string]: unknown;
}

export interface OpenAIUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
}

export interface OpenAIChatChoice {
	index?: number;
	message?: OpenAIChatMessage;
	finish_reason?: string;
}

export interface OpenAIChatResponse {
	choices: OpenAIChatChoice[];
	usage?: OpenAIUsage;
}
