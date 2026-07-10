/**
 * OpenAI Realtime API Configuration (WebSocket)
 * For streaming transcription with Voice Activity Detection
 *
 * Reference: https://platform.openai.com/docs/guides/speech-to-text#streaming-the-transcription-of-an-ongoing-audio-recording
 */

export interface RealtimeTranscriptionSession {
	object: 'realtime.transcription_session';
	id: string;
	input_audio_format: 'pcm16' | 'g711_ulaw' | 'g711_alaw';
	input_audio_transcription: {
		model: 'whisper-1' | 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe';
		prompt?: string;
		language?: string;
	};
	turn_detection?: {
		type: 'server_vad';
		threshold: number;
		prefix_padding_ms: number;
		silence_duration_ms: number;
	} | null;
	input_audio_noise_reduction?: {
		type: 'near_field' | 'far_field';
	};
	include?: string[];
}

export interface RealtimeApiConfig {
	endpoint: {
		websocket: string;
		sessionEndpoint: string;
	};

	models: {
		'whisper-1': { displayName: string };
		'gpt-4o-transcribe': { displayName: string };
		'gpt-4o-mini-transcribe': { displayName: string };
	};

	audioFormats: {
		pcm16: { sampleRate: number; bitDepth: number; channels: number };
		g711_ulaw: { sampleRate: number };
		g711_alaw: { sampleRate: number };
	};

	vadDefaults: {
		threshold: number;
		prefix_padding_ms: number;
		silence_duration_ms: number;
	};

	noiseReduction: {
		near_field: { description: string };
		far_field: { description: string };
	};
}

export const REALTIME_API_CONFIG: RealtimeApiConfig = {
	endpoint: {
		websocket: 'wss://api.openai.com/v1/realtime',
		sessionEndpoint: 'https://api.openai.com/v1/realtime/transcription_sessions'
	},

	models: {
		'whisper-1': { displayName: 'Whisper v1' },
		'gpt-4o-transcribe': { displayName: 'GPT-4o Transcribe' },
		'gpt-4o-mini-transcribe': { displayName: 'GPT-4o Mini Transcribe' }
	},

	audioFormats: {
		pcm16: {
			sampleRate: 16000,
			bitDepth: 16,
			channels: 1 // Mono
		},
		g711_ulaw: { sampleRate: 8000 },
		g711_alaw: { sampleRate: 8000 }
	},

	vadDefaults: {
		threshold: 0.5,
		prefix_padding_ms: 300,
		silence_duration_ms: 500
	},

	noiseReduction: {
		near_field: { description: 'Optimized for close microphone placement' },
		far_field: { description: 'Optimized for distant microphone placement' }
	}
};

/**
 * Build Realtime API session configuration
 */
export function buildRealtimeSessionConfig(options: {
	model?: 'whisper-1' | 'gpt-4o-transcribe' | 'gpt-4o-mini-transcribe';
	language?: string;
	prompt?: string;
	enableVAD?: boolean;
	vadThreshold?: number;
	noiseReduction?: 'near_field' | 'far_field';
	includeLogprobs?: boolean;
}): RealtimeTranscriptionSession {
	const config = REALTIME_API_CONFIG;

	const session: RealtimeTranscriptionSession = {
		object: 'realtime.transcription_session',
		id: '', // Will be assigned by server
		input_audio_format: 'pcm16', // Default to PCM16
		input_audio_transcription: {
			model: options.model || 'gpt-4o-transcribe',
			language: options.language || 'ja'
		}
	};

	// Add prompt if provided
	if (options.prompt) {
		session.input_audio_transcription.prompt = options.prompt;
	}

	// Configure VAD if enabled
	if (options.enableVAD !== false) { // Default to enabled
			session.turn_detection = {
				type: 'server_vad',
				threshold: options.vadThreshold ?? config.vadDefaults.threshold,
				prefix_padding_ms: config.vadDefaults.prefix_padding_ms,
				silence_duration_ms: config.vadDefaults.silence_duration_ms
			};
	} else {
		session.turn_detection = null;
	}

	// Configure noise reduction
	if (options.noiseReduction) {
		session.input_audio_noise_reduction = {
			type: options.noiseReduction
		};
	}

	// Include logprobs if requested
	if (options.includeLogprobs) {
		session.include = ['item.input_audio_transcription.logprobs'];
	}

	return session;
}

/**
 * Create WebSocket URL with intent
 */
export function getRealtimeWebSocketUrl(intent: 'transcription' = 'transcription'): string {
	return `${REALTIME_API_CONFIG.endpoint.websocket}?intent=${intent}`;
}

/**
 * Convert audio buffer to PCM16 format for Realtime API
 */
export function convertToPCM16(audioData: Float32Array): ArrayBuffer {
	const buffer = new ArrayBuffer(audioData.length * 2);
	const view = new DataView(buffer);

	for (let i = 0; i < audioData.length; i++) {
		// Convert float32 (-1 to 1) to int16 (-32768 to 32767)
		const value = audioData[i] ?? 0;
		const sample = Math.max(-1, Math.min(1, value));
		const int16 = Math.floor(sample * 32767);
		view.setInt16(i * 2, int16, true); // Little-endian
	}

	return buffer;
}

/**
 * Create audio buffer append message for WebSocket
 */
export function createAudioAppendMessage(audioData: ArrayBuffer): string {
	// Convert ArrayBuffer to base64
	const uint8Array = new Uint8Array(audioData);
	let binary = '';
	for (let i = 0; i < uint8Array.byteLength; i++) {
		const byte = uint8Array[i] ?? 0;
		binary += String.fromCharCode(byte);
	}
	const base64Audio = btoa(binary);

	return JSON.stringify({
		type: 'input_audio_buffer.append',
		audio: base64Audio
	});
}

/**
 * Parse Realtime API event
 */
export interface RealtimeEvent {
	type: string;
	item_id?: string;
	previous_item_id?: string;
	transcript?: string;
	is_final?: boolean;
}

export function parseRealtimeEvent(data: string): RealtimeEvent | null {
	try {
		const parsed: unknown = JSON.parse(data);
		if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
			return parsed as RealtimeEvent;
		}
		return null;
	} catch {
		return null;
	}
}
