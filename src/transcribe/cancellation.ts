import { t } from "./vendor/i18n/index";

/**
 * Whether an error thrown by a transcription pass is a user cancellation (which
 * must propagate) rather than a recoverable failure. Mirrors the cases the
 * vendored controller itself treats as cancellation.
 *
 * Lives in its own leaf module (imports only the vendored i18n) so both the
 * backend-agnostic orchestrator ({@link ./TranscriptionService}) and the
 * concrete backends can share it without an import cycle.
 */
export function isDiarizationCancelled(error: unknown, signal?: AbortSignal): boolean {
	return (
		(signal?.aborted ?? false) ||
		(error instanceof DOMException && error.name === "AbortError") ||
		(error instanceof Error && error.message === t("errors.transcriptionCancelledByUser"))
	);
}
