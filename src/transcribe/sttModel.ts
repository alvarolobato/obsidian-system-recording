/**
 * Pure helpers for mapping a transcription model id onto the vendored engine's
 * family. Kept free of Obsidian imports so it can be unit-tested and reused by
 * both the settings UI and the plugin's settings-migration logic.
 */

/**
 * Engine families the vendored transcriber understands. This drives request
 * routing (Whisper vs GPT-4o API), chunk sizing, and word-timestamp handling.
 * The actual model *name* sent on the wire is `sttModel` (which can be any
 * gateway deployment id, e.g. `llm-gateway/whisper`).
 */
export const STT_MODELS = [
	"gpt-4o-transcribe",
	"gpt-4o-mini-transcribe",
	"whisper-1",
	"whisper-1-ts",
] as const;

export type SttApiType = (typeof STT_MODELS)[number];

/** Best-effort guess of the engine family from a model id, used to auto-fill the API type. */
export function inferSttApiType(modelId: string): SttApiType {
	const name = modelId.toLowerCase();
	if (name.includes("whisper")) {
		return "whisper-1-ts";
	}
	if (name.includes("mini")) {
		return "gpt-4o-mini-transcribe";
	}
	return "gpt-4o-transcribe";
}

/** The subset of settings {@link canSeparateSpeakers} needs — kept separate from the plugin's full settings shape so this file stays free of Obsidian imports. */
export interface DiarizationGateSettings {
	diarizationEnabled: boolean;
	sttApiType: SttApiType;
	/** null = never probed, or invalidated by a later config change. */
	sttTimestampsSupported: boolean | null;
	/** The `${baseUrl}::${wireModel}` key the flag above was probed against. */
	sttTimestampsProbeKey: string;
}

/**
 * Gates me-vs-them speaker separation. True only when the user turned it on,
 * the engine family is the timestamped Whisper family (the only one that
 * makes the engine request timestamps at all), the endpoint has been probed
 * and confirmed to actually honor them, and that probe is still fresh (its
 * key matches the current endpoint + wire model, so a stale "yes" from a
 * since-changed gateway can't leak through).
 */
export function canSeparateSpeakers(
	s: DiarizationGateSettings,
	currentKey: string
): boolean {
	return (
		s.diarizationEnabled &&
		s.sttApiType === "whisper-1-ts" &&
		s.sttTimestampsSupported === true &&
		s.sttTimestampsProbeKey === currentKey
	);
}
