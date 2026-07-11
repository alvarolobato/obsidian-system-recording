/**
 * Probes whether the configured speech-to-text endpoint actually returns
 * segment timestamps for `verbose_json` requests. Deployment names on a
 * gateway (e.g. `llm-gateway/whisper`) don't tell us anything about the
 * backend behind them, so the only reliable way to know is to ask it with a
 * throwaway clip and look at what comes back. The WAV generation and response
 * parsing are pure so they can be unit-tested without a network stack; only
 * `probeTimestampSupport` itself talks to the endpoint.
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
 * True iff a parsed `/audio/transcriptions` response carries at least one
 * segment, meaning the backend actually honored `response_format:
 * verbose_json` (with `timestamp_granularities[]=segment`) instead of
 * silently falling back to a plain-text transcript.
 */
export function responseHasSegments(json: unknown): boolean {
	if (!json || typeof json !== "object") return false;
	const segments = (json as { segments?: unknown }).segments;
	return Array.isArray(segments) && segments.length > 0;
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

/** Builds a multipart/form-data body by hand — same approach the vendored WhisperClient uses, since Obsidian's requestUrl takes raw bytes, not a FormData object. */
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

export interface ProbeTimestampSupportOptions {
	baseUrl: string;
	apiKey: string;
	/** The model id actually sent on the wire (a gateway deployment name, or the canonical id). */
	wireModel: string;
}

/**
 * Sends a throwaway clip to `${baseUrl}/audio/transcriptions` asking for
 * `verbose_json` with segment timestamps, exactly like the vendored
 * WhisperClient does, and reports whether segments came back. Network,
 * HTTP, and parse errors all read as "not detected" — a probe failure should
 * never surface as an exception to the caller, just an honest "no".
 */
export async function probeTimestampSupport(
	opts: ProbeTimestampSupportOptions
): Promise<boolean> {
	try {
		const { body, contentType } = buildMultipartBody(
			[
				["model", opts.wireModel],
				["response_format", "verbose_json"],
				["timestamp_granularities[]", "segment"],
			],
			{ name: "probe.wav", type: "audio/wav", data: makeProbeWav() }
		);
		const res = await requestUrl({
			url: `${opts.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`,
			method: "POST",
			headers: {
				Authorization: `Bearer ${opts.apiKey}`,
				"Content-Type": contentType,
			},
			body,
			throw: false,
		});
		if (res.status < 200 || res.status >= 300) return false;
		return responseHasSegments(res.json);
	} catch {
		return false;
	}
}
