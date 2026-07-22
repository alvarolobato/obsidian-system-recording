/**
 * Local WebRTC-VAD speech-window detection for the diarized (me/them) path.
 *
 * The recorder ships a crude RMS energy gate (`speech.json`) that can't tell
 * speech from music, keyboard noise, or system-audio bleed into the mic — so
 * Whisper's silence hallucinations on the mostly-silent streams slip through.
 * Here we run the bundled WebRTC VAD (fvad.wasm) over each mono stream and emit
 * real speech windows, which `mergeDiarized` uses to drop any transcript
 * segment that lands outside detected speech.
 *
 * Crucially this is a *window* detector, not the silence-removing preprocessor:
 * we never touch the audio, so both streams keep their shared wall-clock and
 * the merge stays aligned. Windows are absolute seconds in the original stream.
 *
 * Everything degrades gracefully: if the WASM is missing (e.g. a BRAT install
 * that didn't fetch the asset) or decoding fails, we return undefined and the
 * caller falls back to the recorder's speech.json (or no filtering at all).
 */
import { TFile } from "obsidian";

import { PathUtils } from "./vendor/utils/PathUtils";
import { WebRTCVADProcessor } from "./vendor/vad/processors/WebrtcVadProcessor";

import type { SpeechWindows } from "./diarize";
import type { VADConfig } from "./vendor/vad/VadTypes";
import type { App } from "obsidian";

/**
 * Tuned to over-keep rather than over-drop: windows only *gate* Whisper
 * segments (a segment survives if it touches any window), so generous padding
 * and gap-merging make it very unlikely to clip a real utterance, while still
 * rejecting the long silent stretches where Whisper invents filler.
 */
const VAD_CONFIG: VADConfig = {
	enabled: true,
	processor: "webrtc",
	// 0.6 -> fvad "aggressive" mode (2): rejects most non-speech energy without
	// being so strict it drops quiet talkers.
	sensitivity: 0.6,
	minSpeechDuration: 0.2,
	// Bridge sub-0.6s gaps so a single sentence stays one window.
	maxSilenceDuration: 0.6,
	// Pad each side so segment boundaries near a window edge still overlap it.
	speechPadding: 0.3,
	debug: false,
};

/** WebRTC VAD's native rate; decode straight to it to skip a second resample. */
const VAD_SAMPLE_RATE = 16000;

/** Downmix an AudioBuffer to a single Float32 channel. */
function toMono(buffer: AudioBuffer): Float32Array {
	if (buffer.numberOfChannels === 1) {
		return buffer.getChannelData(0);
	}
	const length = buffer.length;
	const channels = buffer.numberOfChannels;
	const mono = new Float32Array(length);
	for (let ch = 0; ch < channels; ch++) {
		const data = buffer.getChannelData(ch);
		for (let i = 0; i < length; i++) {
			mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / channels;
		}
	}
	return mono;
}

/**
 * Decode an audio file (wav or m4a) to mono PCM at 16 kHz. Decoding into a
 * 16 kHz context lets the browser resample once, up front, so the whole file
 * never sits in RAM at the capture rate.
 *
 * Memory note: this still materializes the full mono stream (~115 MB/hour at
 * 16 kHz Float32) plus the VAD's internal Int16 copy. The two streams are
 * processed serially so only one is resident at a time; for very long
 * meetings (2h+) a streaming/frame-based decode is the proper fix (tracked as
 * a follow-up). If decoding OOMs, computeSpeechWindows swallows it and the
 * caller falls back to the recorder's RMS windows.
 */
export async function decodeMono16k(
	app: App,
	file: TFile
): Promise<{ audioData: Float32Array; sampleRate: number }> {
	const buf = await app.vault.readBinary(file);
	const Ctor =
		window.AudioContext ??
		(window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
	if (!Ctor) {
		throw new Error("AudioContext unavailable");
	}
	const ctx = new Ctor({ sampleRate: VAD_SAMPLE_RATE });
	try {
		// slice(0): decodeAudioData detaches the buffer it's handed.
		const decoded = await ctx.decodeAudioData(buf.slice(0));
		return { audioData: toMono(decoded), sampleRate: decoded.sampleRate };
	} finally {
		void ctx.close();
	}
}

/**
 * Whether `fvad.wasm` is present in any location the loader searches. Checked up
 * front so a missing binary — a BRAT/community install before (or without) the
 * on-demand fetch, an offline first run — skips VAD *cleanly* instead of letting
 * the vendored processor throw and log two scary ERRORs on every diarized pass.
 * Missing is an expected, benign fallback (to the recorder's RMS windows), not a
 * failure worth surfacing.
 */
async function fvadWasmAvailable(app: App): Promise<boolean> {
	let paths: string[];
	try {
		paths = PathUtils.getWasmFilePaths(app, "fvad.wasm");
	} catch {
		return false;
	}
	for (const p of paths) {
		try {
			if (await app.vault.adapter.exists(p)) return true;
		} catch {
			// unreadable candidate — keep checking the rest
		}
	}
	return false;
}

/** Run VAD over one stream and return its speech windows as [start, end] seconds. */
async function windowsForFile(app: App, file: TFile): Promise<Array<[number, number]>> {
	const { audioData, sampleRate } = await decodeMono16k(app, file);
	const vad = new WebRTCVADProcessor(app, VAD_CONFIG, PathUtils.getCurrentPluginId());
	await vad.initialize();
	try {
		const result = await vad.processAudio(audioData, sampleRate);
		return result.segments.map((s) => [s.start, s.end] as [number, number]);
	} finally {
		await vad.cleanup();
	}
}

/**
 * Compute per-stream speech windows for the me/them sidecars using local WebRTC
 * VAD. Returns undefined (never throws) when VAD can't run, so callers can fall
 * back to the recorder's RMS speech.json.
 */
export async function computeSpeechWindows(
	app: App,
	meFile: TFile,
	themFile: TFile
): Promise<SpeechWindows | undefined> {
	try {
		// Skip cleanly when fvad.wasm isn't present (e.g. a BRAT install whose
		// on-demand fetch hasn't landed) so the vendored loader doesn't throw +
		// log ERRORs; the caller falls back to the recorder's RMS windows.
		if (!(await fvadWasmAvailable(app))) {
			console.debug(
				"[Meeting Copilot][vad] fvad.wasm not found; using recorder RMS windows"
			);
			return undefined;
		}
		// Serialize the two passes: each briefly holds the whole stream in RAM,
		// and they share the single vendored fvad module state.
		const me = await windowsForFile(app, meFile);
		const them = await windowsForFile(app, themFile);
		// debug, not warn: this runs on every diarized pass and the fallback
		// below is an expected, benign path (e.g. missing WASM on a BRAT
		// install), so it shouldn't look like a problem in the console.
		console.debug(
			`[Meeting Copilot][vad] local VAD windows: me=${me.length}, them=${them.length}`
		);
		return { me, them };
	} catch (error) {
		console.debug(
			"[Meeting Copilot][vad] local VAD unavailable; falling back to recorder RMS windows",
			error
		);
		return undefined;
	}
}
