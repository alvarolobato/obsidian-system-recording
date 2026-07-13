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
	"You are an expert meeting-notes assistant. You distill a participant's raw " +
	"notes and a meeting transcript into concise, faithful notes a busy " +
	"colleague can skim in under a minute. You favor signal over completeness: " +
	"short, telegraphic bullets, no filler, no meta-commentary. You never " +
	"invent facts.";

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

Write concise, skimmable meeting notes in Markdown. A reader should get the gist in under a minute. Prefer fewer, sharper bullets over exhaustive coverage — this is a summary, not a transcript.

Structure:
- Open with a "### TL;DR" section: 2–4 short bullets capturing the essence — main outcome, key decisions, and anything urgent.
- Follow with a handful of thematic sections (aim for 3–6, not one per tangent). Give each a short, descriptive "### " heading named in its own terms (for example "### Entity model"). Invent fitting headings; do not use generic labels like "Key points", "Discussion", or "Decisions".
- Under each heading use a few terse "- " bullets — sentence fragments, not full sentences. Merge related points into one bullet; never split a single idea across several.
- Nest a sub-bullet ("  - ") only when a point truly needs one concrete detail (a number, name, or example). Never go deeper than one level, and use nesting sparingly.
- Fold the participant's own notes into the relevant sections; never drop anything they wrote.
- Finish with a "### Next steps" section listing action items as "- **Concise task** (Owner)". Add an owner only when the discussion makes it clear. Omit the whole section if there are genuinely no action items.

Keep it tight:
- Match length to substance: a short meeting yields a short note. Do not pad. As a rough ceiling, keep the whole thing well under one screen of text for a typical 30-minute meeting.
- Cover what matters and drop the rest: skip small talk, greetings, scheduling back-and-forth, and tangents that don't change any decision.
- Write the substance directly. Never refer to "the meeting", "this session", "the call", "the transcript", "the recording", or "the notes", and never comment on what was or wasn't said, recorded, or discussed.
- Never open a bullet with filler like "Discussed", "Noted that", "Acknowledged", "Talked about", "Mentioned", or "The point was raised" — state the fact itself.
- If there is little or no substantive content, output only the little that exists (a short TL;DR with a bullet or two) and nothing more.
- Ground every statement in the notes and/or transcript; never invent facts, names, numbers, or decisions. When they conflict, prefer the participant's notes.
- Do not quote the transcript verbatim or narrate it turn by turn.
- Output only the Markdown notes — no preamble, no closing remarks, and no top-level "#" heading.`;

/** System role for generating a concise meeting title. */
export const TITLE_SYSTEM_PROMPT =
	"You write short, specific titles for meeting notes.";

/**
 * Builds the user prompt asking for a concise title from the notes/transcript.
 * Keep this tight — the response is used directly as a filename, so it must be
 * a single plain line.
 */
export function buildTitlePrompt(notes: string, transcript: string): string {
	const n = notes.trim() || "(none)";
	const t = transcript.trim() || "(none)";
	return `Suggest a concise, specific title for the following notes — at most 8 words, in Title Case. Do not include dates, quotes, markdown, or trailing punctuation. Output only the title on a single line.

Notes:
"""
${n}
"""

Transcript:
"""
${t}
"""`;
}

const PLACEHOLDER = /\{\{(title|date|attendees|notes|transcript)\}\}/g;

/** Fills a prompt template with the context, defaulting empty fields to "(none)". */
export function fillPrompt(template: string, ctx: EnrichmentContext): string {
	return template.replace(PLACEHOLDER, (_m, key: keyof EnrichmentContext) => {
		const value = ctx[key];
		return value && value.trim().length > 0 ? value : "(none)";
	});
}
