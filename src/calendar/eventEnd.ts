/**
 * What to do with an in-progress recording when the calendar event it belongs
 * to crosses its scheduled end time.
 *
 *  - `"none"`      — nothing to do (not recording, or a different meeting is the
 *                    active recording, so this event's end mustn't touch it).
 *  - `"auto-stop"` — the user opted into calendar auto-stop; stop now.
 *  - `"defer"`     — a conferencing app is *still* in a meeting, so the
 *                    scheduled end is just the calendar boundary and the real
 *                    meeting is running over. Don't nag with a stop suggestion;
 *                    the meeting detector fires its own "meeting ended → stop?"
 *                    prompt when the meeting actually ends.
 *  - `"prompt-stop"` — offer to stop (a recording never stops on its own).
 */
export type EventEndAction = "none" | "auto-stop" | "defer" | "prompt-stop";

export interface EventEndInput {
	/** Whether a recording is currently running. */
	isRecording: boolean;
	/**
	 * Whether the running recording is the one for the event that just ended.
	 * Guards against an overlapping meeting's end stopping the wrong recording.
	 */
	isThisEventsRecording: boolean;
	/** The user opted into stopping automatically at a calendar event's end. */
	autoStop: boolean;
	/**
	 * How many conferencing apps the detector currently sees in a meeting, or
	 * `null` when meeting detection can't answer (disabled, no probes enabled,
	 * or unsupported platform). `null` means "unknown", so we fall back to
	 * prompting at the calendar boundary rather than deferring on a guess.
	 */
	detectedOngoing: number | null;
}

/**
 * Decides how to handle an in-progress recording at its calendar event's end.
 * Pure so the branching (auto-stop vs. defer-to-detector vs. prompt) is
 * unit-testable without Obsidian. Auto-stop keeps priority over deferral: it's
 * an explicit "stop at the calendar boundary" opt-in, distinct from the
 * suggestion this deferral is about.
 */
export function eventEndStopAction(input: EventEndInput): EventEndAction {
	if (!input.isRecording || !input.isThisEventsRecording) return "none";
	if (input.autoStop) return "auto-stop";
	// A meeting is still detected as ongoing: the scheduled end is just the
	// calendar boundary. Defer the suggestion to the detector's meeting-ended
	// path so we only prompt once the real meeting is over.
	if (input.detectedOngoing !== null && input.detectedOngoing > 0) {
		return "defer";
	}
	return "prompt-stop";
}
