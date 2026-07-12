import Foundation
import AVFoundation

// MARK: - Argument parsing

let args = CommandLine.arguments
guard args.count >= 6,
      args[1] == "start",
      args[2] == "--output",
      args[4] == "--stop-file" else {
    let errorJson = "{\"status\": \"error\", \"message\": \"Usage: system-recorder start --output <path> --stop-file <path> [--split]\"}"
    FileHandle.standardOutput.write(Data((errorJson + "\n").utf8))
    exit(1)
}

let finalOutputPath = args[3]
let stopFilePath = args[5]

// Optional flag after the required args. Absent = exactly today's behavior.
let split = args.count > 6 && args[6] == "--split"

// Record to a temp file, then move to final path when done
let tempOutputURL = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("system-recorder-\(ProcessInfo.processInfo.processIdentifier).wav")

// MARK: - JSON output helper

func emitJSON(_ dict: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: dict),
       let str = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((str + "\n").utf8))
    }
}

// MARK: - Main recording logic

if #available(macOS 13.0, *) {
    let captureManager = AudioCaptureManager()
    let mixer: AudioMixer

    do {
        mixer = try AudioMixer(outputURL: tempOutputURL, split: split)
    } catch {
        emitJSON(["status": "error", "message": "Failed to create audio writer: \(error.localizedDescription)"])
        exit(1)
    }

    // Wire system audio → mixer
    captureManager.onSystemAudio = { sampleBuffer in
        mixer.appendSystemAudio(sampleBuffer)
    }

    // Wire microphone audio → mixer
    captureManager.onMicrophoneAudio = { buffer, _ in
        mixer.appendMicrophoneAudio(buffer)
    }

    // Start capture
    _ = Task {
        do {
            try await captureManager.startCapture()
            emitJSON(["status": "recording", "duration": 0])
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
            try? FileManager.default.removeItem(atPath: stopFilePath)

            Task {
                await captureManager.stopCapture()
                let duration = await mixer.finalize()

                // Move temp file to final destination
                let finalURL = URL(fileURLWithPath: finalOutputPath)
                try? FileManager.default.moveItem(at: tempOutputURL, to: finalURL)

                let stopped: [String: Any] = ["status": "stopped", "duration": Int(duration), "file": finalOutputPath]

                // When split, relocate the sidecars next to the final recording.
                // Discovery downstream is by naming convention, so we don't
                // report the paths back; a missing sidecar is skipped and never
                // fails the recording.
                if split {
                    let finalSidecars = AudioMixer.sidecarURLs(forBase: finalURL)
                    let moves: [(temp: URL, final: URL)] = [
                        (mixer.meSidecarURL, finalSidecars.me),
                        (mixer.themSidecarURL, finalSidecars.them),
                        (mixer.speechSidecarURL, finalSidecars.speech),
                    ]
                    for move in moves {
                        guard FileManager.default.fileExists(atPath: move.temp.path) else { continue }
                        if FileManager.default.fileExists(atPath: move.final.path) {
                            try? FileManager.default.removeItem(at: move.final)
                        }
                        try? FileManager.default.moveItem(at: move.temp, to: move.final)
                    }
                }

                emitJSON(stopped)
                exit(0)
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
