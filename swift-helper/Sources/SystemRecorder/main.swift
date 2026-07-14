import Foundation
import AVFoundation

// MARK: - Argument parsing

let usage = "Usage: system-recorder start --output <path> --stop-file <path> [--split] [--format \(RecordingFormat.usageList)] [--input-device <uid>]\n       system-recorder list-devices"

// MARK: - JSON output helper

func emitJSON(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let str = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((str + "\n").utf8))
    }
}

// Emit through JSONSerialization, not string interpolation: messages carry
// localizedDescriptions, and a stray quote must not produce invalid JSON for
// the plugin's line parser.
func fail(_ message: String) -> Never {
    emitJSON(["status": "error", "message": message])
    exit(1)
}

let args = CommandLine.arguments

// `list-devices`: enumerate input (microphone) devices as JSON for the
// settings picker, then exit. No capture, no permissions needed.
if args.count >= 2, args[1] == "list-devices" {
    let devices = AudioDevices.inputDevices().map { ["uid": $0.uid, "name": $0.name] }
    emitJSON(["devices": devices])
    exit(0)
}

guard args.count >= 6,
      args[1] == "start",
      args[2] == "--output",
      args[4] == "--stop-file" else {
    fail(usage)
}

let finalOutputPath = args[3]
let stopFilePath = args[5]

// Optional flags after the required args. All absent = mono 24 kHz WAV, no
// sidecars, system-default input device.
var split = false
var format = RecordingFormat.wav
// Record from a specific input device (by stable UID) instead of the system
// default. Empty/nil = system default; a UID that no longer resolves falls
// back to the default with a warning (see AudioCaptureManager).
var inputDeviceUID: String?
var argIndex = 6
while argIndex < args.count {
    switch args[argIndex] {
    case "--split":
        split = true
        argIndex += 1
    case "--format":
        guard argIndex + 1 < args.count,
              let parsed = RecordingFormat(rawValue: args[argIndex + 1]) else {
            fail(usage)
        }
        format = parsed
        argIndex += 2
    case "--input-device":
        guard argIndex + 1 < args.count else { fail(usage) }
        let uid = args[argIndex + 1]
        inputDeviceUID = uid.isEmpty ? nil : uid
        argIndex += 2
    default:
        fail(usage)
    }
}

// Record to a temp file, then move to final path when done. The extension
// matters: AVAudioFile picks the container from it.
let tempOutputURL = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent(
        "system-recorder-\(ProcessInfo.processInfo.processIdentifier).\(format.fileExtension)"
    )

/// Move that survives an existing destination and a cross-volume temp dir,
/// and throws instead of silently dropping the finished recording (issue
/// #10). An existing destination is only removed once its replacement is
/// fully staged next to it, and `source` is kept until the very end, so a
/// failure at any step leaves the recording recoverable (in `source` and/or
/// the `.partial` staging file) rather than deleting the only copy. The
/// staged copy also means a write that dies mid-flight (disk full) never
/// leaves a partial file at the final path for naming-convention discovery
/// to pick up as a recording.
func moveReplacing(from source: URL, to destination: URL) throws {
    let fm = FileManager.default
    // Fast path: nothing to replace, so a plain rename is safe and atomic.
    if !fm.fileExists(atPath: destination.path) {
        do {
            try fm.moveItem(at: source, to: destination)
            return
        } catch {
            // Cross-volume rename isn't allowed; fall through to staged copy.
        }
    }
    // Stage the new content beside the destination before touching the
    // existing file, so a failed copy can't leave the destination missing.
    let staging = destination.appendingPathExtension("partial")
    try? fm.removeItem(at: staging)
    try fm.copyItem(at: source, to: staging)
    if fm.fileExists(atPath: destination.path) {
        try fm.removeItem(at: destination)
    }
    try fm.moveItem(at: staging, to: destination)
    try? fm.removeItem(at: source)
}

// MARK: - Main recording logic

if #available(macOS 13.0, *) {
    let captureManager = AudioCaptureManager()
    captureManager.preferredInputDeviceUID = inputDeviceUID
    let mixer: AudioMixer

    do {
        mixer = try AudioMixer(outputURL: tempOutputURL, format: format, split: split)
    } catch {
        fail("Failed to create audio writer: \(error.localizedDescription)")
    }

    // Wire system audio → mixer
    captureManager.onSystemAudio = { sampleBuffer in
        mixer.appendSystemAudio(sampleBuffer)
    }

    // Wire microphone audio → mixer
    captureManager.onMicrophoneAudio = { buffer, _ in
        mixer.appendMicrophoneAudio(buffer)
    }

    // Surface non-fatal capture recovery failures (e.g. a device-change restart
    // that didn't take) without ending the recording.
    captureManager.onWarning = { message in
        emitJSON(["status": "warning", "message": message])
    }

    // Fail fast on a dead capture. Both sources feed the mixer within a second
    // or two even in silence, so zero frames well past capture start means it
    // never came up — most often because an audio device change (Zoom launching
    // after we start and grabbing the input/output device) stopped both paths
    // before recovery could re-establish them, or because the helper's Screen
    // Recording / Microphone TCC grant was invalidated (its code hash changed on
    // an update). Without this the user records a whole meeting into the void and
    // only learns at stop ("No audio was captured").
    //
    // Scheduled only AFTER startCapture() reports "recording" (so a slow
    // SCShareableContent call or a first-run TCC prompt doesn't count against the
    // window) and cancelled the moment stop is requested — a DispatchWorkItem so
    // cancellation is thread-safe and can't race the finalize/exit path.
    let watchdogSeconds = 15.0
    let watchdog = DispatchWorkItem {
        let frames = mixer.capturedFrames
        if frames.system == 0 && frames.mic == 0 {
            fail(
                "No audio captured after \(Int(watchdogSeconds))s. If a meeting app (e.g. Zoom) started after recording, stop and start recording again once it's running. Otherwise grant Obsidian both Screen Recording and Microphone access in System Settings → Privacy & Security and restart Obsidian."
            )
        }
    }

    // Start capture
    _ = Task {
        do {
            try await captureManager.startCapture()
            emitJSON(["status": "recording", "duration": 0])
            DispatchQueue.global().asyncAfter(
                deadline: .now() + watchdogSeconds, execute: watchdog
            )
        } catch {
            emitJSON(["status": "error", "message": "Failed to start capture: \(error.localizedDescription)"])
            exit(1)
        }
    }

    // Duration ticker + stop file check every 0.5 seconds
    let startDate = Date()
    let ticker = DispatchSource.makeTimerSource(queue: .global())
    ticker.schedule(deadline: .now() + 0.5, repeating: 0.5)
    ticker.setEventHandler {
        // Check if stop file exists
        if FileManager.default.fileExists(atPath: stopFilePath) {
            ticker.cancel()
            // Cancel the no-audio watchdog so it can't fire during finalize.
            watchdog.cancel()
            try? FileManager.default.removeItem(atPath: stopFilePath)

            Task {
                await captureManager.stopCapture()

                do {
                    let duration = try mixer.finalize()

                    // Move temp file to final destination
                    let finalURL = URL(fileURLWithPath: finalOutputPath)
                    try moveReplacing(from: tempOutputURL, to: finalURL)

                    let stopped: [String: Any] = ["status": "stopped", "duration": Int(duration), "file": finalOutputPath]

                    // When split, relocate the sidecars next to the final
                    // recording. Discovery downstream is by naming convention,
                    // so we don't report the paths back; a missing sidecar is
                    // skipped and never fails the recording.
                    if split {
                        let finalSidecars = AudioMixer.sidecarURLs(forBase: finalURL)
                        let moves: [(temp: URL, final: URL)] = [
                            (mixer.meSidecarURL, finalSidecars.me),
                            (mixer.themSidecarURL, finalSidecars.them),
                            (mixer.speechSidecarURL, finalSidecars.speech),
                        ]
                        for move in moves {
                            guard FileManager.default.fileExists(atPath: move.temp.path) else { continue }
                            try? moveReplacing(from: move.temp, to: move.final)
                        }
                    }

                    emitJSON(stopped)
                    exit(0)
                } catch {
                    // Name every surviving copy of the audio: the finished mix
                    // (present when only the move into the vault failed, since
                    // finalize deletes the stream temps on its success path)
                    // and the per-stream PCM temps. A failed stop must not
                    // leave the only copy of the meeting unfindable.
                    var salvage = mixer.salvageablePaths
                    if FileManager.default.fileExists(atPath: tempOutputURL.path) {
                        salvage.insert(tempOutputURL.path, at: 0)
                    }
                    var message = "Failed to finalize recording: \(error.localizedDescription)"
                    if !salvage.isEmpty {
                        message += " — captured audio preserved at: \(salvage.joined(separator: ", "))"
                    }
                    emitJSON(["status": "error", "message": message])
                    exit(1)
                }
            }
            return
        }

        let elapsed = Int(Date().timeIntervalSince(startDate))
        emitJSON(["status": "recording", "duration": elapsed])
    }
    ticker.resume()

    // Keep run loop alive
    RunLoop.current.run(until: Date.distantFuture)

} else {
    emitJSON(["status": "error", "message": "macOS 13.0 or later is required"])
    exit(1)
}
