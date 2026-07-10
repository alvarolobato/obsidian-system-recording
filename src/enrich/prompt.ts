/** Context assembled from the meeting note and calendar frontmatter. */
export interface EnrichmentContext {
	title: string;
	date: string;
	attendees: string;
	notes: string;
	transcript: string;
}

/** Fixed system role; the editable part is the user prompt below. */
export const ENRICH_SYSTEM_PROMPT =
	"You are an expert meeting-notes assistant. You turn raw notes and a " +
	"transcript into clear, faithful meeting notes. You never invent facts and " +
	"you keep the output tight.";

/** Default, Granola-style user prompt. Placeholders are filled by fillPrompt(). */
export const DEFAULT_ENRICH_PROMPT = `Meeting: {{title}}
Date: {{date}}
Attendees: {{attendees}}

The participant's own notes (may be sparse or empty):
"""
{{notes}}
"""

Transcript (may be empty):
"""
{{transcript}}
"""

Write enhanced meeting notes in Markdown using EXACTLY these level-3 sections, in this order, and nothing else (no preamble, no top-level heading):

### Summary
- 2–4 bullet TL;DR of what was discussed and why it matters.

### Key points
- The most important discussion points, grouped logically.

### Decisions
- Decisions that were made. If none, write "- None".

### Action items
- [ ] Owner — the task. Use an attendee's name as the owner where the text makes it clear; otherwise omit the owner.

Rules:
- Ground every statement in the notes and/or transcript; do not invent facts, names, or numbers.
- When the notes and transcript conflict, prefer the participant's notes.
- Be concise; do not restate the transcript verbatim.`;

const PLACEHOLDER = /\{\{(title|date|attendees|notes|transcript)\}\}/g;

/** Fills a prompt template with the context, defaulting empty fields to "(none)". */
export function fillPrompt(template: string, ctx: EnrichmentContext): string {
	return template.replace(PLACEHOLDER, (_m, key: keyof EnrichmentContext) => {
		const value = ctx[key];
		return value && value.trim().length > 0 ? value : "(none)";
	});
}
