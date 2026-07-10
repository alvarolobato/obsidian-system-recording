/** Callout used for the AI-generated (enriched) notes, styled gray via styles.css. */
export const ENRICH_CALLOUT_TYPE = "ai-notes";
export const ENRICH_CALLOUT_TITLE = "AI notes";
/** Body class toggled to hide all enriched callouts (Granola-style toggle). */
export const HIDE_AI_CLASS = "mc-hide-ai";

/** Quotes each line so blank lines stay inside the callout. */
function quote(text: string): string {
	return text
		.trim()
		.split("\n")
		.map((l) => (l.length ? `> ${l}` : ">"))
		.join("\n");
}

/** Formats enriched markdown as an expanded (`+`) gray callout. */
export function formatEnrichedCallout(markdown: string): string {
	return `> [!${ENRICH_CALLOUT_TYPE}]+ ${ENRICH_CALLOUT_TITLE}\n${quote(markdown)}`;
}

/** Removes a previously-inserted enriched callout, wherever it sits. */
export function stripEnriched(content: string): string {
	const lines = content.split("\n");
	const out: string[] = [];
	const marker = new RegExp(`^>\\s*\\[!${ENRICH_CALLOUT_TYPE}\\][+-]?`);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (marker.test(line)) {
			i++;
			while (i < lines.length && /^>/.test(lines[i] ?? "")) i++;
			i--;
			continue;
		}
		out.push(line);
	}
	return out.join("\n");
}

const FRONTMATTER = /^(---\n[\s\S]*?\n---\n)/;

/**
 * Places the enriched callout near the top of the body — after any YAML
 * frontmatter and the first H1 title — replacing an existing one. Pure/testable.
 */
export function withEnrichedBlock(content: string, markdown: string): string {
	const stripped = stripEnriched(content);
	const block = formatEnrichedCallout(markdown);

	const fm = FRONTMATTER.exec(stripped);
	const head = fm?.[1] ?? "";
	const rest = stripped.slice(head.length).replace(/^\n+/, "");

	const lines = rest.split("\n");
	const insertAt = lines.length > 0 && /^#\s/.test(lines[0] ?? "") ? 1 : 0;
	const before = lines.slice(0, insertAt).join("\n").replace(/\s+$/, "");
	const after = lines.slice(insertAt).join("\n").replace(/^\s+/, "");

	const bodyParts: string[] = [];
	if (before) bodyParts.push(before);
	bodyParts.push(block);
	if (after) bodyParts.push(after);
	const body = bodyParts.join("\n\n");

	return `${head ? `${head}\n` : ""}${body}\n`;
}

/** Returns the body of a `## <heading>` section (until the next heading), trimmed. */
export function extractSection(content: string, heading: string): string {
	const lines = content.split("\n");
	const h = heading.trim();
	const start = lines.findIndex((l) => l.trim() === h);
	if (start === -1) return "";
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (/^#{1,2}\s/.test(lines[i] ?? "")) {
			end = i;
			break;
		}
	}
	return lines.slice(start + 1, end).join("\n").trim();
}

/** Returns the transcript text from its callout (un-quoted), or "". */
export function extractTranscript(content: string): string {
	const lines = content.split("\n");
	const marker = /^>\s*\[![\w-]+\][+-]?\s*Transcript\s*$/;
	const start = lines.findIndex((l) => marker.test(l));
	if (start === -1) return "";
	const body: string[] = [];
	for (let i = start + 1; i < lines.length; i++) {
		const l = lines[i] ?? "";
		if (!/^>/.test(l)) break;
		body.push(l.replace(/^>\s?/, ""));
	}
	return body.join("\n").trim();
}
