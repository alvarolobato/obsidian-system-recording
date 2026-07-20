import { describe, it, expect } from "vitest";
import { eventEndStopAction, type EventEndInput } from "./eventEnd";

/** A recording of THIS event is running, no auto-stop, detection sees nothing. */
const base: EventEndInput = {
	isRecording: true,
	isThisEventsRecording: true,
	autoStop: false,
	detectedOngoing: 0,
};

describe("eventEndStopAction", () => {
	it("does nothing when not recording", () => {
		expect(eventEndStopAction({ ...base, isRecording: false })).toBe("none");
	});

	it("does nothing when the active recording is a different meeting", () => {
		expect(
			eventEndStopAction({ ...base, isThisEventsRecording: false })
		).toBe("none");
	});

	it("auto-stops when the user opted into calendar auto-stop", () => {
		expect(eventEndStopAction({ ...base, autoStop: true })).toBe(
			"auto-stop"
		);
	});

	it("prompts to stop when no meeting is detected as ongoing", () => {
		expect(eventEndStopAction({ ...base, detectedOngoing: 0 })).toBe(
			"prompt-stop"
		);
	});

	it("prompts to stop when detection can't answer (null)", () => {
		expect(eventEndStopAction({ ...base, detectedOngoing: null })).toBe(
			"prompt-stop"
		);
	});

	it("defers the suggestion while a conferencing app is still in a meeting", () => {
		expect(eventEndStopAction({ ...base, detectedOngoing: 1 })).toBe(
			"defer"
		);
		expect(eventEndStopAction({ ...base, detectedOngoing: 2 })).toBe(
			"defer"
		);
	});

	it("auto-stop takes priority over an ongoing detected meeting", () => {
		// Auto-stop is an explicit 'stop at the calendar boundary' opt-in, which
		// is a separate choice from the deferred suggestion.
		expect(
			eventEndStopAction({
				...base,
				autoStop: true,
				detectedOngoing: 1,
			})
		).toBe("auto-stop");
	});

	it("recording-state checks win over auto-stop (nothing to stop)", () => {
		expect(
			eventEndStopAction({
				...base,
				isRecording: false,
				autoStop: true,
				detectedOngoing: 1,
			})
		).toBe("none");
	});
});
