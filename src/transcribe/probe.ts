/**
 * Probes whether the configured speech-to-text endpoint actually returns
 * segment timestamps for `verbose_json` requests. Deployment names on a
 * gateway (e.g. `llm-gateway/whisper`) don't tell us anything about the
 * backend behind them, so the only reliable way to know is to ask it with a
 * throwaway clip and look at what comes back. The WAV generation and response
 * parsing are pure so they can be unit-tested without a network stack; only
 * `probeSttSupport` itself talks to the endpoint.
 */
import { requestUrl } from "obsidian";

const SAMPLE_RATE = 16000;
const DURATION_SECONDS = 0.5;
const TONE_HZ = 440;
// Quiet on purpose: we only care that the backend accepts and transcribes the
// file, not what it makes of the tone.
const AMPLITUDE = 0.05;

/** Builds a ~0.5s, 16kHz mono 16-bit PCM WAV of a quiet sine tone, entirely in memory (no assets). */
export function makeProbeWav(): ArrayBuffer {
	const numSamples = Math.round(SAMPLE_RATE * DURATION_SECONDS);
	const dataSize = numSamples * 2; // 16-bit samples = 2 bytes each
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);

	writeAscii(view, 0, "RIFF");
	view.setUint32(4, 36 + dataSize, true);
	writeAscii(view, 8, "WAVE");
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true); // fmt chunk size (PCM)
	view.setUint16(20, 1, true); // AudioFormat = PCM
	view.setUint16(22, 1, true); // NumChannels = mono
	view.setUint32(24, SAMPLE_RATE, true);
	view.setUint32(28, SAMPLE_RATE * 2, true); // ByteRate = SampleRate * BlockAlign
	view.setUint16(32, 2, true); // BlockAlign = channels * bytes/sample
	view.setUint16(34, 16, true); // BitsPerSample
	writeAscii(view, 36, "data");
	view.setUint32(40, dataSize, true);

	for (let i = 0; i < numSamples; i++) {
		const t = i / SAMPLE_RATE;
		const sample = Math.round(
			Math.sin(2 * Math.PI * TONE_HZ * t) * AMPLITUDE * 0x7fff
		);
		view.setInt16(44 + i * 2, sample, true);
	}

	return buffer;
}

function writeAscii(view: DataView, offset: number, text: string): void {
	for (let i = 0; i < text.length; i++) {
		view.setUint8(offset + i, text.charCodeAt(i));
	}
}

/**
 * True iff a parsed `/audio/transcriptions` response carries a `segments`
 * array, meaning the backend honored `response_format: verbose_json` (with
 * `timestamp_granularities[]=segment`). We check for the array's presence, not
 * its length: the probe clip is a short quiet tone, so a capable backend can
 * legitimately transcribe it to nothing and still return `segments: []`. A
 * backend that ignores verbose_json falls back to a plain-text shape with no
 * `segments` field at all, which is the case we want to catch.
 */
export function responseHasSegmentsArray(json: unknown): boolean {
	if (!json || typeof json !== "object") return false;
	const segments = (json as { segments?: unknown }).segments;
	return Array.isArray(segments);
}

/** Canonical `${baseUrl}::${wireModel}` a probe result was captured against, used to detect staleness after a config change. */
export function probeKey(baseUrl: string, wireModel: string): string {
	return `${baseUrl}::${wireModel}`;
}

interface MultipartFile {
	name: string;
	type: string;
	data: ArrayBuffer;
}

/** Builds a multipart/form-data body by hand. The vendored WhisperClient hands a FormData object to ApiClient, and ApiClient is what serializes it to raw bytes because Obsidian's requestUrl can't take a FormData; this does that serialization step directly. */
function buildMultipartBody(
	fields: Array<[string, string]>,
	file: MultipartFile
): { body: ArrayBuffer; contentType: string } {
	const boundary = `----MeetingCopilotProbe${Date.now()}`;
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];

	for (const [key, value] of fields) {
		chunks.push(encoder.encode(`--${boundary}\r\n`));
		chunks.push(
			encoder.encode(
				`Content-Disposition: form-data; name="${key}"\r\n\r\n`
			)
		);
		chunks.push(encoder.encode(`${value}\r\n`));
	}

	chunks.push(encoder.encode(`--${boundary}\r\n`));
	chunks.push(
		encoder.encode(
			`Content-Disposition: form-data; name="file"; filename="${file.name}"\r\n`
		)
	);
	chunks.push(encoder.encode(`Content-Type: ${file.type}\r\n\r\n`));
	chunks.push(new Uint8Array(file.data));
	chunks.push(encoder.encode("\r\n"));
	chunks.push(encoder.encode(`--${boundary}--\r\n`));

	const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const combined = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.length;
	}
	return {
		body: combined.buffer,
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

export interface ProbeSttSupportOptions {
	baseUrl: string;
	apiKey: string;
	/** The model id actually sent on the wire (a gateway deployment name, or the canonical id). */
	wireModel: string;
	/**
	 * Ask for `verbose_json` + segment granularities so timestamp support can be
	 * detected too. Only Whisper honors that shape — gpt-4o `*-transcribe`
	 * models reject verbose_json with a 400 — so leave this off for non-Whisper
	 * families to check transcription support alone (plain `json`).
	 */
	withTimestamps?: boolean;
}

/**
 * Outcome of a probe. "unknown" means we couldn't get a verdict (transport,
 * HTTP, or parse failure) and must not be persisted as a definitive answer,
 * otherwise a transient 429 or timeout would stick as "unsupported" forever.
 */
export type SupportVerdict = "supported" | "unsupported" | "unknown";

/**
 * What a single `/audio/transcriptions` probe tells us about a model:
 * - `transcription`: whether the model can transcribe at all (a 2xx means yes;
 *   a client rejection like 400/404/415/422 means the endpoint refused the
 *   model/route, i.e. it's not a transcription model).
 * - `timestamps`: whether that transcription came back with a `segments` array
 *   (only meaningful when `transcription` is "supported").
 */
export interface SttSupport {
	transcription: SupportVerdict;
	timestamps: SupportVerdict;
}

/** A probe verdict plus a short diagnostic, so an "unknown" outcome can tell the user *why* (HTTP status or transport error) instead of failing silently. */
export interface SttProbeResult extends SttSupport {
	/** HTTP status of the probe response, or null if the request never completed. */
	status: number | null;
	/** Human-readable summary of the outcome (e.g. "HTTP 500", "network error: …"). */
	detail: string;
}

/** HTTP statuses where the endpoint understood the request but refused this model/route — treated as "this model can't transcribe". */
const MODEL_REJECTED_STATUSES = new Set([400, 404, 405, 415, 422]);

/**
 * Derives an {@link SttSupport} verdict from a probe's HTTP status and parsed
 * body. Split out from the request so it can be unit-tested without a network
 * stack. A 2xx means the model transcribes; a client rejection means it
 * doesn't; anything else (auth, rate limit, server error) is "unknown" on both
 * axes. Timestamps are only judged when the request actually asked for them
 * (`checkedTimestamps`) — otherwise their verdict is "unknown".
 */
export function classifySttResponse(
	status: number,
	json: unknown,
	checkedTimestamps: boolean
): SttSupport {
	if (status >= 200 && status < 300) {
		return {
			transcription: "supported",
			timestamps: !checkedTimestamps
				? "unknown"
				: responseHasSegmentsArray(json)
					? "supported"
					: "unsupported",
		};
	}
	if (MODEL_REJECTED_STATUSES.has(status)) {
		return { transcription: "unsupported", timestamps: "unsupported" };
	}
	return { transcription: "unknown", timestamps: "unknown" };
}

/**
 * Sends a throwaway clip to `${baseUrl}/audio/transcriptions` and reports
 * whether the model transcribes and (when `withTimestamps` is set) whether it
 * returned segment timestamps — see {@link classifySttResponse}. A
 * network/parse failure yields "unknown" on both axes so the caller can leave
 * stored results untouched rather than record a false "no".
 */
export async function probeSttSupport(
	opts: ProbeSttSupportOptions
): Promise<SttProbeResult> {
	const withTimestamps = opts.withTimestamps === true;
	try {
		const fields: Array<[string, string]> = withTimestamps
			? [
					["model", opts.wireModel],
					["response_format", "verbose_json"],
					["timestamp_granularities[]", "segment"],
				]
			: [
					["model", opts.wireModel],
					["response_format", "json"],
				];
		const { body, contentType } = buildMultipartBody(fields, {
			name: "probe.wav",
			type: "audio/wav",
			data: makeProbeWav(),
		});
		const res = await requestUrl({
			url: `${opts.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`,
			method: "POST",
			headers: {
				// Omit the Authorization header entirely when no key is set —
				// a blank `Bearer ` can make otherwise-open endpoints reject the
				// probe and be misread as "transcription unsupported".
				...(opts.apiKey
					? { Authorization: `Bearer ${opts.apiKey}` }
					: {}),
				"Content-Type": contentType,
			},
			body,
			throw: false,
		});
		// Touch res.json inside the try so a body that throws on parse lands in
		// the catch as "unknown" rather than crashing the caller.
		const support = classifySttResponse(res.status, res.json, withTimestamps);
		return { ...support, status: res.status, detail: `HTTP ${res.status}` };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			transcription: "unknown",
			timestamps: "unknown",
			status: null,
			detail: `network error: ${msg}`,
		};
	}
}
